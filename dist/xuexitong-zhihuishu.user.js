// ==UserScript==
// @name         学习通 / 智慧树学习助手（适配版）
// @namespace    github.aajddjkfkfke.xuexitong
// @version      1.1.2
// @description  保留学习通功能，支持智慧树共享课视频、连播及文字/公式图片弹题；右侧面板控制，无需本地服务
// @author       aajddjkfkfke
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @match        https://studyvideoh5.zhihuishu.com/stuStudy*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @noframes
// ==/UserScript==

/*
 * 安装：Tampermonkey → 新建脚本 → 全选本文件内容粘贴 → 保存；或直接把本文件拖进浏览器。
 * 使用：打开学习通课程播放页或智慧树共享课 /stuStudy 播放页；视频功能无需 API Key。
 * 倍速：学习通可选 1.0–3.0x；智慧树最高 1.8x（默认“跟随页面”），对当前及后续视频生效。
 * 隐私：API Key 优先保存到油猴存储，无油猴时回退页面 localStorage；面板中以密码框显示。
 * 开启 AI 答题会把题干与选项（含图片）发送至 api.deepseek.com；学习通分支另可能加载 jQuery 和网页字体。
 * 智慧树分支使用真实播放器和目录操作，不伪造学习时长或服务端完成记录。
 * 来源：aajddjkfkfke/xuexitong-zidong-shuake-jiaoben v1.0.7；本文件为智慧树兼容修改版。
 */

(function () {
    'use strict';

    const VERSION = '1.1.2';
    const IS_ZHIHUI = location.hostname === 'studyvideoh5.zhihuishu.com' && /^\/stuStudy(?:\/|$)/.test(location.pathname);
    const PLATFORM_NAME = IS_ZHIHUI ? '智慧树共享课' : '学习通';
    const BOOT_KEY = '__xuexitongDeepSeekPanelBooted';
    const API_URL = 'https://api.deepseek.com/chat/completions';
    const MODELS_URL = 'https://api.deepseek.com/models';
    const LOG_LIMIT = 300;

    if (window[BOOT_KEY]) return;
    window[BOOT_KEY] = true;

    /* ---------------------------------------------------------------- 设置 */

    const storage = {
        get(key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    const value = GM_getValue(key, fallback);
                    return value === undefined ? fallback : value;
                }
                const raw = localStorage.getItem('xt_ds_' + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (error) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                if (typeof GM_setValue === 'function') GM_setValue(key, value);
                else localStorage.setItem('xt_ds_' + key, JSON.stringify(value));
            } catch (error) {
                /* 存储不可用时静默降级为本次会话有效 */
            }
        },
    };

    const settings = {
        apiKey: String(storage.get('apiKey', '') || ''),
        autoQuiz: storage.get('autoQuiz', true) !== false,
        autoNext: storage.get('autoNext', true) !== false,
        rate: Number(storage.get('rate', 0)) || 0,
        lockRate: storage.get('lockRate', true) !== false,
        position: storage.get('position', null),
        minimized: storage.get('minimized', false) === true,
    };

    const state = {
        app: null,
        mode: 'idle', // idle | waiting | running | error
        activity: '',
    };

    // 页面 jQuery 可能位于沙箱之外（Firefox + Tampermonkey 的 Xray 环境），优先取页面 window。
    const pageWindow = (() => {
        try {
            return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
        } catch (error) {
            return window;
        }
    })();

    function getJQuery() {
        return (pageWindow && pageWindow.jQuery) || window.jQuery || null;
    }

    /* ------------------------------------------------------------ 基础工具 */

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitFor(check, timeout, interval = 50) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (check()) return true;
            await sleep(interval);
        }
        return Boolean(check());
    }

    function truncate(text, max) {
        const value = String(text || '');
        return value.length > max ? value.slice(0, max) + '…' : value;
    }

    function fmt(seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    let rateBlocked = false;

    function installRateLock(video) {
        if (!video || video.__xtRateLockInstalled) return;
        try {
            let proto = Object.getPrototypeOf(video);
            let descriptor = null;
            while (proto && !descriptor) {
                descriptor = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
                proto = Object.getPrototypeOf(proto);
            }
            if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return;
            const setter = function (value) {
                const target = Number(video.__xtRateTarget) || 0;
                const next = Number(value);
                if (!Number.isFinite(next) || next <= 0) return;
                if (target > 0 && Math.abs(next - target) > 0.01) return;
                descriptor.set.call(this, next);
            };
            Object.defineProperty(video, 'playbackRate', {
                configurable: true,
                enumerable: true,
                get() {
                    return descriptor.get.call(this);
                },
                set: setter,
            });
            video.__xtRateLockInstalled = true;
            video.__xtRateLockSetter = setter;
        } catch (error) {
            log('warn', `倍速锁定未生效，改用定时校正：${error.message || error}`);
        }
    }

    function unlockRateLock(video) {
        if (!video || !video.__xtRateLockInstalled) return;
        try {
            delete video.playbackRate;
        } catch (error) {
            /* 忽略 */
        }
        video.__xtRateLockInstalled = false;
    }

    function applyPlaybackRate(video) {
        // 共享课播放器自身以 1.8x 为上限，超过会触发异常提示。
        const rate = IS_ZHIHUI ? Math.min(1.8, Number(settings.rate) || 0) : Number(settings.rate) || 0;
        if (!video || rate <= 0) return;
        video.__xtRateTarget = rate;
        if (settings.lockRate) installRateLock(video);
        if (rateBlocked && !video.__xtRateLockInstalled) return;
        try {
            if (Math.abs(Number(video.defaultPlaybackRate || 1) - rate) > 0.01) video.defaultPlaybackRate = rate;
            if (Math.abs(Number(video.playbackRate || 1) - rate) > 0.01) video.playbackRate = rate;
        } catch (error) {
            /* 个别播放器禁止修改倍速 */
        }
    }

    function isTransientPlayError(error) {
        const name = String(error?.name || '');
        const message = String(error?.message || '');
        return name === 'AbortError' ||
            (name === 'NotSupportedError' && /no supported sources|no source/i.test(message)) ||
            /aborted by the user agent|interrupted by a new load request|The play\(\) request was interrupted/i.test(message);
    }

    function waitForMediaReady(video, timeout = 10000) {
        return new Promise((resolve) => {
            if (!video) {
                resolve(false);
                return;
            }
            if (video.readyState >= 2) {
                resolve(true);
                return;
            }
            let settled = false;
            let timer = null;
            let poll = null;
            const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing'];
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (poll) clearInterval(poll);
                events.forEach((name) => video.removeEventListener(name, onReady));
                video.removeEventListener('error', onError);
                resolve(ok);
            };
            const onReady = () => {
                if (video.readyState >= 2) finish(true);
            };
            const onError = () => finish(false);
            events.forEach((name) => video.addEventListener(name, onReady));
            video.addEventListener('error', onError, { once: true });
            poll = setInterval(() => {
                if (video.readyState >= 2) finish(true);
            }, 200);
            timer = setTimeout(() => finish(video.readyState >= 2), timeout);
        });
    }

    function describeHttpError(response) {
        let detail = '';
        try {
            const data = JSON.parse(response.responseText || 'null');
            detail = data?.error?.message || data?.error || data?.message || '';
        } catch (error) {
            detail = truncate(response.responseText || '', 120);
        }
        if (response.status === 401) return 'DeepSeek 拒绝了 API Key（401），请重新填写';
        if (response.status === 402) return 'DeepSeek 账户余额不足（402）';
        if (response.status === 429) return 'DeepSeek 请求过于频繁（429），请稍后再试';
        return `DeepSeek API 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`;
    }

    /* -------------------------------------------------------- 纯逻辑（可测） */

    /* __XT_PURE_BEGIN__ */
    function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function commonOptionSuffix(options) {
        if (!Array.isArray(options) || options.length < 2) return '';
        const texts = options.map((option) => clean(option.text).replace(/^[A-H][.、．:：]\s*/, ''));
        if (texts.some((text) => !text)) return '';
        const shortest = Math.min(...texts.map((text) => text.length));
        let suffix = '';
        for (let length = 1; length <= Math.min(shortest, 8); length++) {
            const candidate = texts[0].slice(-length);
            if (texts.every((text) => text.endsWith(candidate))) suffix = candidate;
            else break;
        }
        if (suffix.length < 2) return '';
        if (/^[一二三四五六七八九十0-9]+$/.test(suffix)) return '';
        if (['的是', '一项', '以下', '正确', '错误'].includes(suffix)) return '';
        return suffix;
    }

    const TRUSTED_THEMES = new Set([
        '铁路', '公路', '道路', '航线', '主义', '思想', '理论', '制度', '会议', '政策',
        '方针', '路线', '革命', '建设', '发展', '社会', '资本', '市场', '经济', '政治',
        '文化', '历史', '人民', '国家', '政府', '法律', '权利', '义务', '关系', '问题',
        '方法', '原则', '目标', '任务', '阶段', '时期', '过程', '结果', '原因', '条件',
        '特点', '性质', '作用', '意义', '影响', '地位', '标准', '形式', '内容', '结构',
        '功能', '系统', '模式', '方向', '基础', '核心', '关键', '重点', '难点', '科学',
        '技术', '教育', '管理', '组织', '机构', '产品', '质量', '成本', '价格', '货币',
        '银行', '企业', '工厂', '农村', '城市', '地区', '世界', '中国', '美国', '英国',
        '法国', '德国', '日本', '俄罗斯', '欧洲', '亚洲', '非洲', '美洲', '大学', '中学',
        '小学', '学生', '教师', '课程', '考试', '成绩', '学习', '研究', '实验', '数据',
        '网络', '信息', '软件', '硬件', '程序', '算法', '模型', '材料', '能源', '环境',
        '生态', '资源', '人口', '家庭', '婚姻', '道德', '哲学', '宗教', '艺术', '文学',
        '语言', '文字', '新闻', '媒体', '传播', '广告', '消费', '生产', '分配', '交换',
        '劳动', '工作', '职业', '收入', '税收', '财政', '金融', '投资', '贸易', '物流',
        '交通', '运输', '航空', '航天', '军事', '战争', '和平', '安全', '改革', '开放',
        '创新', '合作', '竞争', '效率', '公平', '正义', '自由', '平等', '民主', '法治',
        '文明', '和谐', '诚信', '友善', '爱国', '敬业', '奉献', '责任',
    ]);

    function themeIsTrusted(theme) {
        if (TRUSTED_THEMES.has(theme)) return true;
        for (const word of TRUSTED_THEMES) {
            if (theme.length > word.length && theme.endsWith(word)) return true;
        }
        return false;
    }

    const SYSTEM_PROMPT = '按题意回答全部题目。注意：题干或选项可能经过网页防复制处理，出现整句汉字被替换成部首不同、语义不通的字（例如把“中国特色社会主义”写成“中国悺悷社会主悴”），也可能夹杂无关字。请先利用固定搭配、课程术语和选项反推原句，再按还原后的题意作答；不要把替换字当作专业术语，也不要因无法逐字还原而放弃。每题通常带 theme 字段，表示选项共同后缀（如“铁路”“主义”）；restored 必须包含 theme，题干主题也必须与 theme 一致，若可读字与 theme 冲突，以 theme 为准（例如 theme 为“铁路”、可读字含“电气”时，应还原成“电气化铁路”，不应写成电子计算机）。每题都必须给非空答案，只用该题提供的选项字母且不可重复；单选和判断选一个，多选列出所有正确项。不确定时选最可能的答案。answers 每项除 id、letters 外，再加 restored 字段，写入你还原后的题干（不超过50字）。只输出JSON：{"answers":[{"id":1,"letters":["A"],"restored":"还原后的题干"}]}。';

    const VISION_PROMPT = '题干和选项中的 [图片N] 或 [图片N：说明] 对应随后同名标签的图片。请读取图片中的完整文字、数学公式、上下标、分式和图形，结合题干及各选项求解，不得忽略图片或把图片编号当作题意。image_labels 仅用于把图片与所属题号、题干或选项对应；图片说明只是辅助，公式以图片内容为准。图文题不要根据中文共同后缀猜主题，也不要套用防复制文字还原规则。';

    function questionHasImages(question) {
        return Boolean(question.images?.length || question.options.some(option => option.images?.length));
    }

    function validateImageUrl(image, label) {
        const url = image?.url;
        if (typeof url !== 'string' || !url.trim()) throw new Error(`${label}的图片地址为空，请手动作答`);
        if (/^https?:\/\//i.test(url)) {
            if (url.length > 8192) throw new Error(`${label}的图片地址超过 8192 字符，已停止请求`);
            try {
                const parsed = new URL(url);
                if (!parsed.hostname || !/^https?:$/.test(parsed.protocol)) throw new Error('无效协议');
            } catch (error) {
                throw new Error(`${label}的图片地址格式无效，请手动作答`);
            }
            return url;
        }
        if (/^data:/i.test(url)) {
            if (url.length > 8 * 1024 * 1024) throw new Error(`${label}的图片超过 8 MiB 字符，已停止请求`);
            const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
            if (!match || match[1].length % 4 !== 0) {
                throw new Error(`${label}的图片格式不支持，仅接受 PNG、JPEG、GIF、WebP 的 base64 图片`);
            }
            return url;
        }
        throw new Error(`${label}的图片地址协议不支持，请手动作答`);
    }

    function buildRequestBody(questions, hint = '') {
        const imageContent = [];
        let imageCount = 0;
        let imageCharacters = 0;
        const appendImages = (images, owner) => {
            if (images === undefined) return [];
            if (!Array.isArray(images)) throw new Error(`${owner}的图片列表格式无效，请手动作答`);
            return images.map((image, index) => {
                const label = `${owner} [图片${index + 1}]`;
                if (++imageCount > 24) throw new Error('单次请求的图片超过 24 张，已停止请求');
                const url = validateImageUrl(image, label);
                imageCharacters += url.length;
                if (imageCharacters > 24 * 1024 * 1024) throw new Error('单次请求的图片合计超过 24 MiB 字符，已停止请求');
                imageContent.push({ type: 'text', text: label }, { type: 'image_url', image_url: { url, detail: 'original' } });
                return label;
            });
        };
        const payload = questions.map((question, index) => {
            const labels = appendImages(question.images, `第 ${index + 1} 题题干`);
            const item = {
                id: index + 1,
                type: question.kind,
                question: question.title,
                options: question.options.map((option) => {
                    const result = { letter: option.letter, text: option.text };
                    const optionLabels = appendImages(option.images, `第 ${index + 1} 题选项 ${option.letter}`);
                    if (optionLabels.length) result.image_labels = optionLabels;
                    return result;
                }),
            };
            if (labels.length) item.image_labels = labels;
            const theme = questionHasImages(question) ? '' : commonOptionSuffix(question.options);
            if (theme && themeIsTrusted(theme)) item.theme = theme;
            return item;
        });
        return {
            model: 'deepseek-flash',
            stream: false,
            response_format: { type: 'json_object' },
            thinking: { type: 'enabled' },
            reasoning_effort: 'low',
            max_tokens: 8000,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT + (imageContent.length ? `\n${VISION_PROMPT}` : '') + (hint ? `\n${hint}` : '') },
                { role: 'user', content: imageContent.length ? [{ type: 'text', text: JSON.stringify(payload) }, ...imageContent] : JSON.stringify(payload) },
            ],
        };
    }

    function findThemeMismatches(questions, answers) {
        const byId = new Map();
        for (const item of Array.isArray(answers) ? answers : []) {
            if (item && Number.isInteger(item.id)) byId.set(item.id, item);
        }
        const result = [];
        for (let index = 0; index < questions.length; index++) {
            if (questionHasImages(questions[index])) continue;
            const theme = commonOptionSuffix(questions[index].options);
            if (!theme || !themeIsTrusted(theme)) continue;
            const restored = String(byId.get(index + 1)?.restored || '');
            if (!restored.includes(theme)) result.push({ id: index + 1, theme, restored });
        }
        return result;
    }

    function parseAnswerPayload(content, expectedCount) {
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error('DeepSeek 返回内容不是有效 JSON');
        }
        if (!parsed || !Array.isArray(parsed.answers)) throw new Error('DeepSeek 返回缺少 answers 数组');
        if (parsed.answers.length !== expectedCount) {
            throw new Error(`DeepSeek 返回 ${parsed.answers.length} 个答案，题目数量为 ${expectedCount}`);
        }
        return parsed.answers;
    }

    function validateAnswers(questions, answers) {
        if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('AI 返回的题目数量不匹配');
        const result = new Map();
        for (const item of answers) {
            if (!Number.isInteger(item.id) || result.has(item.id) || !Array.isArray(item.letters)) {
                throw new Error('AI 答案格式错误');
            }
            const question = questions[item.id - 1];
            if (!question) throw new Error('AI 返回未知题号');
            const letters = item.letters.map((letter) => clean(letter).toUpperCase());
            if (!letters.length) throw new Error(`第 ${item.id} 题 AI 未给出选项，已停止提交`);
            if (new Set(letters).size !== letters.length) throw new Error(`第 ${item.id} 题答案包含重复选项，已停止提交`);
            if (question.kind !== '多选题' && letters.length !== 1) {
                throw new Error(`第 ${item.id} 题是${question.kind}，但 AI 返回了 ${letters.length} 个选项，已停止提交`);
            }
            const invalid = letters.filter((letter) => !question.options.some((option) => option.letter === letter));
            if (invalid.length) {
                throw new Error(`第 ${item.id} 题 AI 返回了页面中不存在的选项：${invalid.join('、')}，已停止提交`);
            }
            result.set(item.id, letters);
        }
        return result;
    }
    /* __XT_PURE_END__ */

    /* __XT_FONT_BEGIN__ */
    function fontTag(bytes, offset) {
        return String.fromCharCode(bytes[offset] || 0, bytes[offset + 1] || 0, bytes[offset + 2] || 0, bytes[offset + 3] || 0);
    }

    function fontU16(bytes, offset) {
        return ((bytes[offset] || 0) << 8) | (bytes[offset + 1] || 0);
    }

    function fontU32(bytes, offset) {
        return (((bytes[offset] || 0) << 24) | ((bytes[offset + 1] || 0) << 16) | ((bytes[offset + 2] || 0) << 8) | (bytes[offset + 3] || 0)) >>> 0;
    }

    function readSfntTables(bytes, base = 0) {
        const numTables = fontU16(bytes, base + 4);
        const tables = new Map();
        for (let index = 0; index < numTables; index++) {
            const entry = base + 12 + index * 16;
            if (entry + 16 > bytes.length) break;
            const tag = fontTag(bytes, entry);
            const offset = fontU32(bytes, entry + 8);
            const length = fontU32(bytes, entry + 12);
            if (offset + length <= bytes.length) tables.set(tag, bytes.subarray(offset, offset + length));
        }
        return tables;
    }

    async function inflateZlib(bytes) {
        if (typeof DecompressionStream !== 'function') return null;
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function readWoffTables(bytes) {
        const numTables = fontU16(bytes, 12);
        const tables = new Map();
        for (let index = 0; index < numTables; index++) {
            const entry = 44 + index * 20;
            if (entry + 20 > bytes.length) break;
            const tag = fontTag(bytes, entry);
            const offset = fontU32(bytes, entry + 4);
            const compLength = fontU32(bytes, entry + 8);
            const origLength = fontU32(bytes, entry + 12);
            if (offset + compLength > bytes.length) continue;
            let data = bytes.subarray(offset, offset + compLength);
            if (compLength < origLength) {
                const inflated = await inflateZlib(data);
                if (!inflated) return null;
                data = inflated.subarray(0, origLength);
            }
            tables.set(tag, data);
        }
        return tables;
    }

    function parseCmapTable(bytes) {
        if (!bytes || bytes.length < 4) return null;
        const numTables = fontU16(bytes, 2);
        let best = null;
        for (let index = 0; index < numTables; index++) {
            const record = 4 + index * 8;
            if (record + 8 > bytes.length) break;
            const platform = fontU16(bytes, record);
            const encoding = fontU16(bytes, record + 2);
            const offset = fontU32(bytes, record + 4);
            if (offset + 2 > bytes.length) continue;
            const format = fontU16(bytes, offset);
            if (format !== 4 && format !== 12) continue;
            if (platform === 3 && (encoding === 1 || encoding === 10)) {
                best = offset;
                break;
            }
            if (best === null) best = offset;
        }
        if (best === null) return null;
        const format = fontU16(bytes, best);
        const map = new Map();
        if (format === 4) {
            const segCount = fontU16(bytes, best + 6) / 2;
            const endOffset = best + 14;
            const startOffset = endOffset + segCount * 2 + 2;
            const deltaOffset = startOffset + segCount * 2;
            const rangeOffset = deltaOffset + segCount * 2;
            for (let index = 0; index < segCount; index++) {
                const end = fontU16(bytes, endOffset + index * 2);
                const start = fontU16(bytes, startOffset + index * 2);
                const delta = fontU16(bytes, deltaOffset + index * 2);
                const range = fontU16(bytes, rangeOffset + index * 2);
                if (start === 0xFFFF && end === 0xFFFF) continue;
                for (let code = start; code <= end && code !== 0xFFFF; code++) {
                    let gid;
                    if (range === 0) {
                        gid = (code + delta) & 0xFFFF;
                    } else {
                        const glyphOffset = rangeOffset + index * 2 + range + (code - start) * 2;
                        if (glyphOffset + 1 >= bytes.length) continue;
                        gid = fontU16(bytes, glyphOffset);
                        if (gid !== 0) gid = (gid + delta) & 0xFFFF;
                    }
                    if (gid) map.set(code, gid);
                }
            }
        } else {
            const groupCount = fontU32(bytes, best + 12);
            for (let index = 0; index < groupCount; index++) {
                const group = best + 16 + index * 12;
                if (group + 12 > bytes.length) break;
                const start = fontU32(bytes, group);
                const end = fontU32(bytes, group + 4);
                const startGid = fontU32(bytes, group + 8);
                if (end - start > 200000) continue;
                for (let code = start; code <= end; code++) map.set(code, startGid + (code - start));
            }
        }
        return map;
    }

    function parsePostTable(bytes) {
        const names = [];
        if (!bytes || bytes.length < 34) return names;
        const version = fontU32(bytes, 0);
        if (version !== 0x00020000) return names;
        const count = fontU16(bytes, 32);
        if (count === 0) return names;
        const indices = [];
        for (let index = 0; index < count; index++) indices.push(fontU16(bytes, 34 + index * 2));
        let offset = 34 + count * 2;
        const custom = [];
        while (offset < bytes.length) {
            const length = bytes[offset];
            offset++;
            if (!length) {
                custom.push('');
                continue;
            }
            if (offset + length > bytes.length) break;
            let name = '';
            for (let index = 0; index < length; index++) name += String.fromCharCode(bytes[offset + index]);
            custom.push(name);
            offset += length;
        }
        for (let gid = 0; gid < count; gid++) {
            const index = indices[gid];
            if (index >= 258) names[gid] = custom[index - 258] || '';
        }
        return names;
    }

    function nameCode(name) {
        if (!name) return 0;
        let match = /^uni([0-9A-F]{4,6})$/i.exec(name);
        if (match) return parseInt(match[1], 16);
        match = /^u([0-9A-F]{4,6})$/i.exec(name);
        if (match) return parseInt(match[1], 16);
        return 0;
    }

    function isUsefulCode(code) {
        return (code >= 0x4E00 && code <= 0x9FFF) ||
            (code >= 0x3400 && code <= 0x4DBF) ||
            (code >= 0x20 && code <= 0x7E) ||
            (code >= 0x3000 && code <= 0x303F) ||
            (code >= 0xFF00 && code <= 0xFFEF);
    }

    async function buildFontDecoder(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 12) return null;
        const signature = fontTag(bytes, 0);
        let tables = null;
        if (signature === 'wOFF') tables = await readWoffTables(bytes);
        else if (signature === 'wOF2') return null;
        else if (signature === 'ttcf') tables = readSfntTables(bytes, fontU32(bytes, 12));
        else tables = readSfntTables(bytes);
        if (!tables) return null;
        const cmap = parseCmapTable(tables.get('cmap'));
        if (!cmap || !cmap.size) return null;
        const names = parsePostTable(tables.get('post'));
        const gidToCodes = new Map();
        for (const [code, gid] of cmap) {
            if (!gidToCodes.has(gid)) gidToCodes.set(gid, []);
            gidToCodes.get(gid).push(code);
        }
        const mapping = new Map();
        let namedCount = 0;
        let reverseCount = 0;
        for (const [code, gid] of cmap) {
            const named = names[gid] ? nameCode(names[gid]) : 0;
            if (named && named !== code) {
                mapping.set(code, named);
                namedCount++;
                continue;
            }
            const alternatives = gidToCodes.get(gid) || [];
            const other = alternatives.find((candidate) => candidate !== code && isUsefulCode(candidate));
            if (other) {
                mapping.set(code, other);
                reverseCount++;
            }
        }
        if (!mapping.size) return null;
        return {
            size: mapping.size,
            mode: namedCount ? 'name' : reverseCount ? 'reverse' : 'none',
            decode(text) {
                let result = '';
                for (const char of String(text || '')) {
                    const code = char.codePointAt(0);
                    result += String.fromCodePoint(mapping.get(code) || code);
                }
                return result;
            },
        };
    }
    /* __XT_FONT_END__ */

    let fontDecoderCache = { tried: false, decoder: null };

    function fontResourceUrls(card) {
        const urls = [];
        const add = (url) => {
            const value = String(url || '').trim().replace(/^['"]|['"]$/g, '');
            if (value && !urls.includes(value)) urls.push(value);
        };
        const preferred = [];
        try {
            const family = card ? getComputedStyle(card).fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase() : '';
            for (const sheet of Array.from(document.styleSheets)) {
                let rules = null;
                try {
                    rules = sheet.cssRules;
                } catch (error) {
                    continue;
                }
                for (const rule of Array.from(rules || [])) {
                    if (rule.type !== 5) continue;
                    const ruleFamily = String(rule.style.fontFamily || '').replace(/["']/g, '').trim().toLowerCase();
                    const src = String(rule.style.src || '');
                    const found = src.match(/url\(([^)]+)\)/g) || [];
                    for (const item of found) {
                        const url = item.replace(/^url\(/, '').replace(/\)$/, '');
                        if (family && ruleFamily === family) preferred.push(url);
                        else add(url);
                    }
                }
            }
        } catch (error) {
            /* 跨域样式表忽略 */
        }
        try {
            for (const entry of performance.getEntriesByType('resource')) {
                if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(entry.name)) add(entry.name);
            }
        } catch (error) {
            /* 忽略 */
        }
        preferred.forEach(add);
        const combined = [];
        [...preferred, ...urls].forEach((value) => {
            const url = String(value || '').trim().replace(/^['"]|['"]$/g, '');
            if (url && !combined.includes(url)) combined.push(url);
        });
        return combined.slice(0, 8);
    }

    async function fetchFontBuffer(url) {
        if (String(url).startsWith('data:')) {
            const match = /^data:[^,]*;base64,(.*)$/s.exec(url);
            if (!match) return null;
            const binary = atob(match[1]);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
            return bytes.buffer;
        }
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        return response.arrayBuffer();
    }

    async function ensureFontDecoder(sample, card) {
        if (fontDecoderCache.tried) return fontDecoderCache.decoder;
        fontDecoderCache.tried = true;
        try {
            await Promise.race([document.fonts.ready, sleep(1500)]);
        } catch (error) {
            /* 继续尝试已加载的字体 */
        }
        const urls = fontResourceUrls(card).slice(0, 3);
        for (const url of urls) {
            try {
                const buffer = await fetchFontBuffer(url);
                if (!buffer) continue;
                const decoder = await buildFontDecoder(buffer);
                if (!decoder) continue;
                const decoded = decoder.decode(sample || '');
                const original = Array.from(sample || '');
                const result = Array.from(decoded);
                let changed = 0;
                for (let index = 0; index < Math.min(original.length, result.length); index++) {
                    if (original[index] !== result[index]) changed++;
                }
                if (changed >= 3 && changed >= original.length * 0.3 && /[\u4e00-\u9fff]/.test(decoded)) {
                    fontDecoderCache.decoder = decoder;
                    log('info', `字体解码已启用：${decoder.size} 个映射，模式 ${decoder.mode}（${truncate(String(url).split('/').pop(), 36)}）`);
                    return decoder;
                }
            } catch (error) {
                /* 尝试下一个字体 */
            }
        }
        log('info', '未找到可用的字体映射，继续使用模型还原');
        return null;
    }

    /* ------------------------------------------------------------ 网络请求 */

    function gmRequest(options) {
        return new Promise((resolve, reject) => {
            const details = {
                method: options.method || 'GET',
                url: options.url,
                headers: options.headers || {},
                data: options.data,
                timeout: options.timeout || 120000,
                onload: (response) => resolve({ status: response.status, responseText: response.responseText || '' }),
                onerror: () => reject(new Error('网络请求失败，请检查网络或代理设置')),
                ontimeout: () => reject(new Error('请求超时，请检查网络后重试')),
                onabort: () => reject(new Error('请求已取消')),
            };
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest(details);
                return;
            }
            fetch(details.url, {
                method: details.method,
                headers: details.headers,
                body: details.data,
            })
                .then(async (response) => resolve({ status: response.status, responseText: await response.text() }))
                .catch(() => reject(new Error('网络请求失败（未检测到油猴环境）')));
        });
    }

    async function requestAnswers(questions, hint = '', isCurrent = () => true) {
        const apiKey = currentApiKey();
        if (!apiKey) throw new Error('未填写 DeepSeek API Key，请在面板顶部保存后再开始答题');
        const body = buildRequestBody(questions, hint);
        let lastProblem = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (!isCurrent()) throw new Error('题目上下文已变化，请求已取消');
            const imageCount = questions.reduce((count, q) => count + (q.images?.length || 0) + q.options.reduce((sum, o) => sum + (o.images?.length || 0), 0), 0);
            setActivity(`${attempt === 1 ? '正在请求' : '正在重试'} DeepSeek${imageCount ? `（图文识别 ${imageCount} 张图片）` : ''}…`);
            const response = await gmRequest({
                method: 'POST',
                url: API_URL,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                data: JSON.stringify(body),
                timeout: 120000,
            });
            if (response.status < 200 || response.status >= 300) throw new Error(describeHttpError(response));

            let data;
            try {
                data = JSON.parse(response.responseText || 'null');
            } catch (error) {
                lastProblem = 'DeepSeek 返回内容无法解析';
                data = null;
            }
            const choice = data?.choices?.[0];
            const reason = choice?.finish_reason;
            if (data && reason === 'length') {
                lastProblem = `输出达到长度上限（已生成 ${data.usage?.completion_tokens ?? '未知'} tokens）`;
            } else if (data && reason !== 'stop') {
                throw new Error(`DeepSeek 未正常结束（finish_reason=${reason ?? '缺失'}）`);
            } else if (data) {
                try {
                    return parseAnswerPayload(choice.message?.content || '', questions.length);
                } catch (error) {
                    lastProblem = error.message;
                }
            }
            if (attempt < 2) log('warn', `${lastProblem}，重试一次`);
        }
        throw new Error(`${lastProblem}；重试后仍未获得完整答案，未选择或提交题目`);
    }

    async function askAnswers(questions, isCurrent = () => true) {
        const looseThemes = questions
            .map((question) => commonOptionSuffix(question.options))
            .filter((theme) => theme && !themeIsTrusted(theme));
        if (looseThemes.length) {
            log('warn', `选项主题“${Array.from(new Set(looseThemes)).join('、')}”不在常见词表，跳过主题一致性校验`);
        }
        let rawAnswers = await requestAnswers(questions, '', isCurrent);
        if (!isCurrent()) throw new Error('题目上下文已变化，请求已取消');
        let mismatches = findThemeMismatches(questions, rawAnswers);
        if (mismatches.length) {
            log('warn', `还原结果与选项主题不一致：${mismatches.map((item) => `第${item.id}题(${item.theme})`).join('、')}，重试一次`);
            const hint = `上一轮还原与选项主题不一致：${mismatches.map((item) => `第${item.id}题写成“${truncate(item.restored || '空', 24)}”，选项共同词是“${item.theme}”`).join('；')}。请严格按 theme 重新还原题干并作答，restored 必须包含 theme，不要沿用上一轮的错误还原。`;
            rawAnswers = await requestAnswers(questions, hint, isCurrent);
            mismatches = findThemeMismatches(questions, rawAnswers);
        }
        if (mismatches.length) {
            throw new Error(`题干还原与选项主题不一致（${mismatches.map((item) => `第${item.id}题:${item.theme}`).join('、')}），已停止提交，请核对题目`);
        }
        return { answers: validateAnswers(questions, rawAnswers), rawAnswers };
    }

    /* ---------------------------------------------------------- 页面自动化 */

    const $ = (...args) => {
        const jquery = getJQuery();
        if (!jquery) throw new Error('页面尚未加载 jQuery');
        return jquery(...args);
    };
    const kindPattern = /[\[【](单选题|多选题|判断题)[\]】]/;

    function visible(element) {
        return Boolean(
            element &&
            element.isConnected &&
            element.getClientRects().length &&
            element.ownerDocument.defaultView.getComputedStyle(element).visibility !== 'hidden'
        );
    }

    function pseudoText(element, pseudo) {
        try {
            const content = getComputedStyle(element, pseudo).content;
            if (!content || content === 'none' || content === 'normal') return '';
            const match = /^(["'])([\s\S]*)\1$/.exec(content);
            return clean(match ? match[2] : content);
        } catch (error) {
            return '';
        }
    }

    function courseDocuments() {
        const result = [];
        const visit = (doc, depth) => {
            if (!doc || depth > 3 || result.includes(doc)) return;
            result.push(doc);
            for (const frame of doc.querySelectorAll('iframe')) {
                try {
                    visit(frame.contentDocument, depth + 1);
                } catch (error) {
                    /* 跨域框架忽略 */
                }
            }
        };
        visit(document, 0);
        return result;
    }

    function deepDocuments() {
        const result = [];
        const visit = (root, depth) => {
            if (!root || depth > 6 || result.includes(root)) return;
            if (root.host && root.host.id === 'xt-ds-host') return;
            result.push(root);
            let elements = [];
            try {
                elements = Array.from(root.querySelectorAll('*'));
            } catch (error) {
                return;
            }
            for (const element of elements) {
                if (element.id === 'xt-ds-host') continue;
                if (element.shadowRoot) visit(element.shadowRoot, depth + 1);
            }
            for (const frame of root.querySelectorAll('iframe')) {
                try {
                    visit(frame.contentDocument, depth + 1);
                } catch (error) {
                    /* 跨域框架忽略 */
                }
            }
        };
        visit(document, 0);
        return result;
    }

    function quizCompleted() {
        const scoreShown = courseDocuments().some((doc) => {
            const text = clean(doc.body?.innerText);
            const hasGrade = /本次成绩\s*\d+(?:\.\d+)?\s*分/.test(text);
            return hasGrade && (/章节测验\s*已完成/.test(text) || /我的答案\s*[:：]/.test(text));
        });
        if (scoreShown) return true;
        const cardsFrame = Array.from(document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
            .find((frame) => frame.getClientRects().length > 0);
        const isQuizStep = cardsFrame && new URL(cardsFrame.getAttribute('src'), location.href).searchParams.get('num') === '1';
        return Boolean(isQuizStep && document.querySelector('.posCatalog_active .icon_Completed'));
    }

    function optionElements(card) {
        const labels = Array.from(card.querySelectorAll('span,div,label,li,p,b,i,strong,a'))
            .filter((element) => /^[A-H]$/.test(clean(element.textContent)) &&
                !Array.from(element.children).some((child) => /^[A-H]$/.test(clean(child.textContent))));
        const found = new Map();
        for (const label of labels) {
            const letter = clean(label.textContent);
            if (found.has(letter)) continue;
            let target = label;
            for (let step = 0; step < 5; step++) {
                const parent = target.parentElement;
                if (!parent || parent === card) break;
                const otherLetters = Array.from(parent.querySelectorAll('span,div,label,li,p,b,i,strong,a'))
                    .filter((element) => /^[A-H]$/.test(clean(element.textContent)) && element !== label);
                if (otherLetters.some((element) => !element.contains(label) && !label.contains(element))) break;
                target = parent;
                if (clean(target.innerText).length > 1) break;
            }
            const text = clean(target.innerText).replace(new RegExp(`^${letter}[.、．]?\\s*`), '');
            if (text) found.set(letter, { letter, text, element: target });
        }
        return Array.from(found.values()).sort((a, b) => a.letter.localeCompare(b.letter));
    }

    function extractQuestions(deep = false) {
        const questions = [];
        for (const doc of (deep ? deepDocuments() : courseDocuments())) {
            const body = doc.body || doc;
            if (!body) continue;
            const walker = typeof doc.createTreeWalker === 'function'
                ? doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
                : document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
            const seenCards = new Set();
            let node;
            while ((node = walker.nextNode())) {
                const nodeText = clean(node.textContent);
                const kind = nodeText.match(kindPattern)?.[1] ||
                    (/^(单选题|多选题|判断题)(?:\s*[（(].*)?$/.test(nodeText) ? nodeText.match(/^(单选题|多选题|判断题)/)[1] : '');
                if (!kind || !visible(node.parentElement)) continue;
                let card = node.parentElement;
                let options = [];
                for (let depth = 0; card && depth < 9; depth++, card = card.parentElement) {
                    const cardText = clean(card.innerText);
                    const kinds = cardText.match(new RegExp(kindPattern.source, 'g')) || [];
                    if (kinds.length > 1) break;
                    options = optionElements(card);
                    if (options.length >= 2 && options.length <= 8) break;
                }
                if (!card || options.length < 2 || options.length > 8 || seenCards.has(card)) continue;
                seenCards.add(card);
                const full = card.innerText || '';
                const firstOption = full.search(/(?:^|\n)\s*A\s*(?:[.、．]|\S)/);
                const title = clean(firstOption >= 0 ? full.slice(0, firstOption) :
                    (node.parentElement.innerText || full))
                    .replace(/^\d+\s*/, '')
                    .replace(/^(单选题|多选题|判断题)\s*/, '')
                    .replace(kindPattern, '').trim();
                if (!title || title.length > 500 || options.some((option) => !option.text || option.text.length > 500)) continue;
                let finalTitle = title;
                const theme = commonOptionSuffix(options);
                if (theme && !title.includes(theme)) {
                    const alternatives = [
                        pseudoText(card, '::before'),
                        pseudoText(card, '::after'),
                        card.getAttribute('title'),
                        card.getAttribute('aria-label'),
                        card.getAttribute('data-title'),
                    ].map(clean).filter((value) => value && value.includes(theme));
                    if (alternatives.length) finalTitle = alternatives.sort((a, b) => b.length - a.length)[0];
                }
                questions.push({ kind, title: finalTitle, options, card, doc });
            }
        }
        return questions;
    }

    function findButton(doc, label) {
        const candidates = Array.from(doc.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"],div,span'))
            .filter((element) => visible(element) && clean(element.value || element.innerText) === label);
        return candidates.find((element) => /^(BUTTON|A|INPUT)$/.test(element.tagName)) ||
            candidates.find((element) => !Array.from(element.children).some((child) => clean(child.innerText) === label)) || null;
    }

    function findButtonContaining(doc, label) {
        const match = (element) => visible(element) && clean(element.value || element.innerText).includes(label);
        const primary = Array.from(doc.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"]')).filter(match);
        if (primary.length) return primary.find((element) => /^(BUTTON|A|INPUT)$/.test(element.tagName)) || primary[0];
        const styled = Array.from(doc.querySelectorAll('[class*="btn"],[class*="button"],[class*="submit"]')).filter(match);
        if (styled.length) return styled[0];
        const clickable = Array.from(doc.querySelectorAll('div,span'))
            .filter((element) => match(element) && (element.onclick || getComputedStyle(element).cursor === 'pointer'));
        return clickable[0] || null;
    }

    function clickElement(element) {
        if (!element) return;
        try {
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        } catch (error) {
            /* 忽略 */
        }
        try {
            element.click();
        } catch (error) {
            /* 忽略 */
        }
    }

    function currentActiveCell() {
        try {
            const active = document.querySelector('#coursetree .posCatalog_active');
            if (!active) return '';
            const chapter = active.closest('li');
            if (!chapter) return '';
            const chapters = Array.from(chapter.parentElement.children);
            const chapterIndex = chapters.indexOf(chapter);
            const cells = Array.from(chapter.querySelectorAll('.posCatalog_select:not(.firstLayer)'));
            return `${chapterIndex}:${cells.indexOf(active)}`;
        } catch (error) {
            return '';
        }
    }

    function extractQuestionNearSubmit(submit) {
        let container = submit?.parentElement;
        for (let depth = 0; depth < 6 && container; depth++, container = container.parentElement) {
            if (!container || container === document.body) break;
            const text = clean(container.innerText);
            if (text.length < 6 || text.length > 1000) continue;
            let options = optionElements(container);
            if (options.length < 2) {
                const inputs = Array.from(container.querySelectorAll('input[type="radio"],input[type="checkbox"]'))
                    .filter((input) => visible(input));
                if (inputs.length >= 2) {
                    options = inputs.map((input, index) => {
                        const label = input.closest('label') ||
                            (input.id ? container.querySelector(`label[for="${String(input.id).replace(/"/g, '\\"')}"]`) : null) ||
                            input.nextElementSibling || input.parentElement;
                        const letter = String.fromCharCode(65 + index);
                        const value = clean(label?.innerText || input.value || '');
                        return value ? { letter, text: value.replace(new RegExp(`^${letter}[.、．]?\\s*`), ''), element: label || input } : null;
                    }).filter(Boolean);
                }
            }
            if (options.length < 2 || options.length > 8) continue;
            const kindText = clean(container.innerText);
            const judge = options.length === 2 &&
                options.some((option) => /^对$/.test(option.text)) &&
                options.some((option) => /^错$/.test(option.text));
            const kind = /多选/.test(kindText) ? '多选题' : (/判断/.test(kindText) || judge) ? '判断题' : '单选题';
            const title = kindText
                .replace(/^(单选题|多选题|判断题)\s*/, '')
                .replace(/\s*A\s*[、.．]?\s*[\u4e00-\u9fff][\s\S]*$/, '')
                .replace(/(?:^|\n)\s*(提交|交卷)[\s\S]*$/, '')
                .trim();
            if (title.length < 2) continue;
            return { kind, title: title.slice(0, 500), options, card: container, doc: container.ownerDocument };
        }
        return null;
    }

    function findNextButton() {
        for (const doc of courseDocuments()) {
            const known = doc.querySelector('#prevNextFocusNext, #right1, .nextChapter');
            if (visible(known) && clean(known.innerText || known.title).includes('下一节')) return known;
            const generic = findButton(doc, '下一节');
            if (generic) return generic;
        }
        return null;
    }

    let lastNextDialogNotice = { text: '', at: 0 };

    function findConfirmButton(container) {
        const labels = ['确定', '确认', '继续', '继续学习', '进入下一节', '下一节', '知道了', '是'];
        for (const label of labels) {
            const exact = findButton(container, label);
            if (exact) return exact;
        }
        return Array.from(container.querySelectorAll('button,a,[role="button"]'))
            .find((element) => visible(element) && /确定|确认|继续|下一节|知道了/.test(clean(element.innerText)));
    }

    let lastNextPopupClickAt = 0;

    function clickNextStepPopup(exclude) {
        if (Date.now() - lastNextPopupClickAt < 1500) return false;
        for (const doc of courseDocuments()) {
            const goStudy = Array.from(doc.querySelectorAll('button,a,[role="button"],div,span'))
                .find((element) => visible(element) && clean(element.innerText || element.value) === '去学习');
            if (goStudy) {
                let container = goStudy.parentElement;
                for (let depth = 0; depth < 5 && container; depth++, container = container.parentElement) {
                    const nextButton = Array.from(container.querySelectorAll('button,a,[role="button"],div,span'))
                        .find((element) => visible(element) && clean(element.innerText || element.value) === '下一节' && element !== exclude);
                    if (nextButton) {
                        lastNextPopupClickAt = Date.now();
                        log('info', '确认“任务点未完成”弹窗：点击“下一节”');
                        nextButton.click();
                        return true;
                    }
                }
            }
            const candidates = Array.from(doc.querySelectorAll('button,a,[role="button"],div,span'))
                .filter((element) => visible(element) &&
                    ['下一节', '继续学习'].includes(clean(element.innerText || element.value)) &&
                    element !== exclude);
            const overlay = candidates.find((element) => {
                let node = element;
                for (let depth = 0; depth < 8 && node && node !== doc.body; depth++, node = node.parentElement) {
                    const style = doc.defaultView.getComputedStyle(node);
                    if ((style.position === 'fixed' || style.position === 'absolute') && Number(style.zIndex) >= 100) return true;
                }
                return false;
            });
            if (overlay) {
                lastNextPopupClickAt = Date.now();
                log('info', `确认浮层：点击“${clean(overlay.innerText)}”`);
                overlay.click();
                return true;
            }
        }
        return false;
    }

    function confirmInlineSubmit(doc) {
        const platformButton = doc.querySelector('#popok');
        if (platformButton && visible(platformButton)) {
            platformButton.click();
            return true;
        }
        const dialogs = Array.from(doc.querySelectorAll(
            '[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.layui-layer-page,.el-message-box,.modal,.ans-dialog,.ant-modal'
        ));
        for (const dialog of dialogs) {
            if (!visible(dialog)) continue;
            const text = clean(dialog.innerText);
            if (!text || text.length > 200 || !/提交|确定|确认|继续|回答|正确|错误/.test(text)) continue;
            const confirm = findConfirmButton(dialog);
            if (confirm) {
                confirm.click();
                return true;
            }
        }
        return false;
    }

    function confirmNextStepDialog(exclude) {
        if (clickNextStepPopup(exclude)) return true;
        for (const doc of courseDocuments()) {
            const platformButton = doc.querySelector('#popok');
            if (platformButton && visible(platformButton)) {
                const message = clean(doc.querySelector('#popcontent')?.innerText);
                if (!message || /下一节|下一学习|继续|未完成|任务点|切换|进入|章节|确定|确认/.test(message)) {
                    log('info', `确认下一步弹窗：${truncate(message || '确定', 30)}`);
                    platformButton.click();
                    return true;
                }
            }
            const dialogs = Array.from(doc.querySelectorAll(
                '[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.layui-layer-page,.el-message-box,.modal,.ans-dialog,.ant-modal,[id*="pop"],[class*="dialog"],[class*="Dialog"],[class*="popup"]'
            ));
            for (const dialog of dialogs) {
                if (!visible(dialog)) continue;
                const text = clean(dialog.innerText);
                if (!text || text.length > 240) continue;
                if (!/下一节|下一学习|继续学习|继续|未完成|任务点|切换|进入|章节|确定|确认|是否/.test(text)) continue;
                const confirm = findConfirmButton(dialog) ||
                    dialog.querySelector('.layui-layer-btn0, .el-button--primary, .ant-btn-primary, #popok');
                if (confirm && visible(confirm)) {
                    log('info', `确认下一步弹窗：${truncate(text, 30)}`);
                    confirm.click();
                    return true;
                }
                const now = Date.now();
                if (lastNextDialogNotice.text !== text || now - lastNextDialogNotice.at > 8000) {
                    lastNextDialogNotice = { text, at: now };
                    log('warn', `检测到弹窗但未匹配确认按钮：${truncate(text, 36)}`);
                }
            }
        }
        return false;
    }

    async function revealQuizQuestions() {
        const docs = courseDocuments();
        const submit = docs.map((doc) => findButton(doc, '提交')).find(Boolean);
        if (!submit) return;
        let scroller = submit.parentElement;
        while (scroller && scroller !== submit.ownerDocument.body) {
            const style = scroller.ownerDocument.defaultView.getComputedStyle(scroller);
            if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 100) break;
            scroller = scroller.parentElement;
        }
        if (!scroller || scroller === submit.ownerDocument.body) {
            scroller = submit.ownerDocument.scrollingElement;
        }
        if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 100) return;
        scroller.scrollTop = 0;
        await sleep(80);
        for (let step = 0; step < 50; step++) {
            const bottom = scroller.scrollHeight - scroller.clientHeight;
            if (scroller.scrollTop >= bottom - 2) break;
            scroller.scrollTop = Math.min(bottom, scroller.scrollTop + Math.max(300, scroller.clientHeight * 0.75));
            await sleep(80);
        }
    }

    function attachQuizAutomation(app) {
        const attemptedQuizzes = new Set();
        let quizBusy = false;
        let stopped = false;
        const originalDestroy = app.destroy.bind(app);
        app.destroy = function () {
            stopped = true;
            originalDestroy();
        };

        async function waitForQuizQuestions() {
            let submitDoc = null;
            for (let attempt = 0; attempt < 240; attempt++) {
                if (stopped) throw new Error('脚本已停止');
                if (quizCompleted()) return null;
                submitDoc = courseDocuments().find((doc) => findButton(doc, '提交'));
                if (submitDoc) break;
                if (attempt > 0 && attempt % 30 === 0) log('info', `测验提交按钮仍在加载，已等待 ${attempt / 2} 秒`);
                await sleep(500);
            }
            if (!submitDoc) throw new Error('进入章节测验后等待 120 秒，仍未找到“提交”按钮。请检查题目框架是否正常加载');

            await revealQuizQuestions();
            let previousSignature = '';
            let stableCount = 0;
            for (let attempt = 0; attempt < 240; attempt++) {
                if (stopped) throw new Error('脚本已停止');
                if (quizCompleted()) return null;
                const questions = extractQuestions();
                const countText = clean(submitDoc.body.innerText).match(/题量\s*[:：]\s*(\d+)/);
                const expected = countText ? Number(countText[1]) : null;
                if (questions.length && (!expected || questions.length === expected)) {
                    const signature = questions.map((q) => `${q.kind}:${q.title}:${q.options.length}`).join('|');
                    stableCount = signature === previousSignature ? stableCount + 1 : 0;
                    previousSignature = signature;
                    if (stableCount >= 3) return questions;
                } else {
                    stableCount = 0;
                    previousSignature = '';
                }
                if (attempt > 0 && attempt % 30 === 0) {
                    log('info', `测验题目仍在加载，已等待 ${attempt / 2} 秒；当前识别 ${questions.length} 道`);
                }
                await sleep(500);
            }
            throw new Error('测验框架已打开，但等待 120 秒仍未识别完整题目。可点击面板“识别题目”查看结果');
        }

        async function selectAnswers(questions, answers) {
            for (let index = 0; index < questions.length; index++) {
                const question = questions[index];
                for (const letter of answers.get(index + 1)) {
                    if (stopped) throw new Error('脚本已停止');
                    const option = question.options.find((item) => item.letter === letter);
                    if (!option?.element?.isConnected) throw new Error(`第 ${index + 1} 题选项已变化`);
                    option.element.scrollIntoView({ block: 'center' });
                    const before = question.card.outerHTML;
                    option.element.click();
                    const applied = await waitFor(() => {
                        if (stopped) throw new Error('脚本已停止');
                        if (question.card.outerHTML !== before) return true;
                        const input = option.element.matches('input') ? option.element : option.element.querySelector('input');
                        return Boolean(input?.checked) || option.element.getAttribute('aria-checked') === 'true';
                    }, 700, 40);
                    if (!applied) throw new Error(`第 ${index + 1} 题 ${letter} 选项未确认选中，已停止提交`);
                }
            }
        }
        app._selectAnswers = selectAnswers;

        async function confirmSubmitDialog() {
            for (let attempt = 0; attempt < 20; attempt++) {
                if (stopped) throw new Error('脚本已停止');
                const dialogs = courseDocuments().flatMap((doc) =>
                    Array.from(doc.querySelectorAll('#popok,[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.el-message-box,.modal')));
                const platformButton = dialogs.find((element) => element.id === 'popok' && visible(element));
                if (platformButton) {
                    const message = clean(platformButton.ownerDocument.querySelector('#popcontent')?.innerText);
                    if (/未作答|请选择|请作答|答完/.test(message) && !/确定提交|确认提交/.test(message)) {
                        throw new Error(`平台拒绝提交：${message}`);
                    }
                    log('info', `确认平台提交窗口：${message || '提交'}`);
                    platformButton.click();
                    return;
                }
                const dialog = dialogs.find((element) => element.id !== 'popok' && visible(element) && /提交|交卷/.test(clean(element.innerText)));
                if (dialog) {
                    const confirm = findButton(dialog, '确定') || findButton(dialog, '确认') || findButton(dialog, '提交');
                    if (!confirm) throw new Error('提交确认窗口未找到确认按钮');
                    confirm.click();
                    return;
                }
                await sleep(120);
            }
        }

        async function submitQuiz(doc) {
            if (stopped) throw new Error('脚本已停止');
            const submit = findButton(doc, '提交');
            if (!submit) throw new Error('未找到测验提交按钮');
            submit.scrollIntoView({ block: 'center' });
            const enabled = await waitFor(() => !submit.disabled, 3000, 100);
            if (!enabled) log('warn', '提交按钮仍显示禁用，尝试直接点击');
            log('info', '选项已选择，点击章节测验的提交按钮');
            submit.click();
            await confirmSubmitDialog();
            log('info', '提交已确认，等待学习通生成成绩或任务完成标记');
            let elapsedHalfSeconds = 0;
            while (!stopped) {
                await sleep(500);
                elapsedHalfSeconds++;
                if (quizCompleted()) return;
                if (elapsedHalfSeconds % 30 === 0) log('info', `成绩页仍在加载，已等待 ${elapsedHalfSeconds / 2} 秒`);
            }
            throw new Error('脚本已停止');
        }

        async function goToNextStep() {
            if (stopped) throw new Error('脚本已停止');
            if (!settings.autoNext) {
                app._nextUnitPending = false;
                log('warn', '已关闭自动跳节：当前步骤完成后请手动点击“下一节”');
                setActivity('等待手动切换下一节');
                return;
            }
            const next = findNextButton();
            if (!next) throw new Error('未找到页面下方的“下一节”按钮');
            app._nextUnitPending = true;
            const previousStep = app._currentStepTitle();
            const previousCell = currentActiveCell();
            app._clearCheckInterval();
            app._videoEl = null;
            app._isPlaying = false;
            next.scrollIntoView({ block: 'center' });
            log('info', `${previousStep || '当前学习步骤'}完成，点击页面“下一节”，等待新内容加载`);
            clickElement(next);
            let currentStep = '';
            let stepReady = false;
            let retries = 0;
            let lastClickAt = Date.now();
            for (let attempt = 0; attempt < 480; attempt++) {
                if (stopped) throw new Error('脚本已停止');
                await sleep(250);
                if (attempt % 4 === 0) confirmNextStepDialog(next);
                currentStep = app._currentStepTitle();
                if (currentStep !== previousStep && currentStep === '章节测验') {
                    stepReady = true;
                    break;
                }
                if (currentStep !== previousStep && currentStep === '视频') {
                    app._videoEl = null;
                    if (app._getVideoEl()) {
                        stepReady = true;
                        break;
                    }
                }
                if (previousCell && currentActiveCell() && currentActiveCell() !== previousCell) {
                    stepReady = true;
                    break;
                }
                if (previousStep === '章节测验' && currentStep === '章节测验' && !quizCompleted()) {
                    stepReady = true;
                    break;
                }
                if (Date.now() - lastClickAt > 4000 && retries < 10) {
                    const retryButton = findNextButton();
                    if (retryButton) {
                        retries++;
                        retryButton.scrollIntoView({ block: 'center' });
                        clickElement(retryButton);
                        lastClickAt = Date.now();
                        log('warn', `“下一节”点击未生效，重试第 ${retries} 次`);
                    } else {
                        lastClickAt = Date.now();
                    }
                }
                if (attempt > 0 && attempt % 40 === 0) {
                    log('info', `下一学习步骤仍在加载，已等待 ${Math.round(attempt / 4)} 秒；当前页签：${currentStep || '未显示'}`);
                }
            }
            if (!stepReady) {
                throw new Error(`点击“下一节”后等待 120 秒，新学习步骤仍未加载完成；当前页签：${currentStep || '未显示'}`);
            }
            app._nextUnitPending = false;
            app._videoEl = null;
            app._initCellData();
            app.play();
        }

        app.nextUnit = function () {
            if (stopped || this._nextUnitPending) return;
            this._nextUnitPending = true;
            goToNextStep().catch((error) => {
                this._nextUnitPending = false;
                if (stopped) return;
                log('error', `切换下一学习步骤失败：${error.message || error}`);
                setActivity('切换失败：' + (error.message || ''));
                setMode('error');
            });
        };

        app.inspectQuiz = function () {
            return extractQuestions().map((question, index) => ({
                id: index + 1,
                type: question.kind,
                question: question.title,
                options: question.options.map((option) => `${option.letter}. ${option.text}`),
            }));
        };

        app._advanceChapterTest = function () {
            if (stopped || quizBusy) return;
            if (!settings.autoQuiz) {
                this._isPlaying = false;
                log('warn', '已关闭自动答题：停留在测验页，请手动作答或点击面板“下一节”');
                setActivity('测验页（自动答题已关闭）');
                return;
            }
            quizBusy = true;
            (async () => {
                if (quizCompleted()) {
                    log('success', '检测到当前章节测验已完成，进入下一学习步骤');
                    await goToNextStep();
                    return;
                }
                log('info', '已进入章节测验，等待题目和提交按钮加载');
                const questions = await waitForQuizQuestions();
                if (questions === null) {
                    log('success', '检测到当前章节测验已完成，进入下一学习步骤');
                    await goToNextStep();
                    return;
                }
                if (questions.length > 30) throw new Error('题目数量超过 30，已停止自动提交');
                const docs = new Set(questions.map((question) => question.doc));
                if (docs.size !== 1) throw new Error('题目跨多个框架，已停止自动提交');
                const decoder = await (async () => {
                    try {
                        const first = questions[0];
                        const sample = first ? [first.title, ...first.options.map((option) => option.text)].join(' ') : '';
                        return await ensureFontDecoder(sample, first?.card);
                    } catch (error) {
                        log('warn', `字体解码失败：${error.message || error}`);
                        return null;
                    }
                })();
                if (decoder) {
                    for (const question of questions) {
                        question.title = decoder.decode(question.title);
                        for (const option of question.options) option.text = decoder.decode(option.text);
                    }
                    log('info', '已用页面字体映射还原题干和选项');
                }
                const countText = clean(questions[0].doc.body.innerText).match(/题量\s*[:：]\s*(\d+)/);
                if (countText && Number(countText[1]) !== questions.length) {
                    throw new Error(`页面显示 ${countText[1]} 道题，脚本只识别 ${questions.length} 道，已停止提交`);
                }
                const signature = questions.map((question) => `${question.kind}:${question.title}`).join('|');
                if (attemptedQuizzes.has(signature)) throw new Error('本次测验已尝试过，已停止重复提交');
                log('info', `识别到 ${questions.length} 道题，开始请求 DeepSeek`);
                log('info', '题干若含替换字，模型会先还原再作答，下面会显示还原结果');
                setActivity(`识别到 ${questions.length} 道题，等待 DeepSeek 作答…`);
                const { answers, rawAnswers } = await askAnswers(questions);
                const restoredById = new Map(rawAnswers
                    .filter((item) => typeof item.restored === 'string' && item.restored.trim())
                    .map((item) => [item.id, item.restored.trim()]));
                for (let index = 0; index < questions.length; index++) {
                    const theme = commonOptionSuffix(questions[index].options);
                    log('info', `${index + 1}. [${questions[index].kind}] ${truncate(questions[index].title, 34)} → ${answers.get(index + 1).join('')}${theme ? `（主题：${theme}）` : ''}`);
                    const restored = restoredById.get(index + 1);
                    if (restored) log('info', `   ↳ 还原：${truncate(restored, 48)}`);
                }
                if (!restoredById.size) log('warn', '模型未返回还原后的题干；若页面替换字较多，请核对答案后再提交');
                setActivity('答案已生成，正在选择选项…');
                await selectAnswers(questions, answers);
                attemptedQuizzes.add(signature);
                await submitQuiz(questions[0].doc);
                log('success', '章节测验提交已确认，进入下一学习步骤');
                quizBusy = false;
                await goToNextStep();
            })().catch((error) => {
                app._nextUnitPending = false;
                if (stopped) return;
                log('error', `章节测验自动作答停止：${error.message || error}`);
                setActivity('测验停止：' + (error.message || ''));
                setMode('error');
            }).finally(() => {
                quizBusy = false;
            });
        };
    }

    /* ------------------------------------------------------ 智慧树共享课适配 */

    function zhText(element) {
        return clean(element?.innerText ?? element?.textContent ?? '');
    }

    function zhVisible(element) {
        if (!element || !element.isConnected || !element.getClientRects().length) return false;
        for (let node = element; node; node = node.parentElement) {
            const style = node.ownerDocument.defaultView.getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        }
        return true;
    }

    function zhDocuments() {
        return courseDocuments();
    }

    function zhVideoItems() {
        // 实际共享课目录的章节标题和章节测试均不是视频任务。
        for (const doc of zhDocuments()) {
            const directories = Array.from(doc.querySelectorAll('.chapterScrollbar'))
                .filter(directory => directory.querySelector('li.video'));
            const active = directories.filter(directory => directory.querySelector('li.video.current_play'));
            const directory = active.length === 1 ? active[0] : directories.length === 1 ? directories[0] : null;
            if (directory) return Array.from(directory.querySelectorAll('li.video'));
            if (directories.length) return [];
            const lists = Array.from(doc.querySelectorAll('ul.list')).filter(list => list.querySelector('li.video'));
            const activeLists = lists.filter(list => list.querySelector('li.video.current_play'));
            const list = activeLists.length === 1 ? activeLists[0] : lists.length === 1 ? lists[0] : null;
            if (list) return Array.from(list.querySelectorAll('li.video'));
        }
        return [];
    }

    function zhQuizRoots() {
        return zhDocuments().flatMap(doc => Array.from(doc.querySelectorAll('#playTopic-dialog,.dialog-test')))
            .filter((root, index, roots) => zhVisible(root) && !roots.some((other, i) => i !== index && other.contains(root)));
    }

    function zhRichContent(element) {
        const images = [];
        const doc = element?.ownerDocument || document;
        const read = node => {
            if (node.nodeType === 3) return node.nodeValue || '';
            if (node.nodeType !== 1) return '';
            const tag = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript'].includes(tag)) return '';
            if (tag === 'img') {
                const raw = (node.getAttribute('src') || node.getAttribute('data-src') || '').trim();
                let url = raw;
                try {
                    if (raw) {
                        const parsed = new URL(raw, doc.baseURI);
                        // 旧课件使用 HTTP 图片地址，浏览器实际也会升级为 HTTPS。
                        if (parsed.protocol === 'http:' && parsed.hostname.endsWith('.zhihuishu.com')) parsed.protocol = 'https:';
                        url = parsed.href;
                    }
                } catch (error) { /* 保留无效源，由请求校验明确报错，不能漏图后盲答。 */ }
                const alt = clean(node.getAttribute('alt') || node.getAttribute('title'));
                images.push({ url, alt });
                return ` [图片${images.length}${alt ? `：${alt}` : ''}] `;
            }
            if (tag === 'br') return ' ';
            const text = Array.from(node.childNodes).map(read).join('');
            if (tag === 'sup') return `^(${text})`;
            if (tag === 'sub') return `_(${text})`;
            return ['p', 'div', 'li'].includes(tag) ? ` ${text} ` : text;
        };
        return { text: clean(element ? read(element) : ''), images };
    }

    function zhContentIdentity(content) {
        return [content.text, (content.images || []).map(image => image.url)];
    }

    function zhQuestions() {
        return zhQuizRoots().flatMap(root => Array.from(root.querySelectorAll('.topic-title')).filter(zhVisible).map(title => {
            const typeText = zhText(title.querySelector('.title-tit'));
            const kind = /多选/.test(typeText) ? '多选题' : /单选/.test(typeText) ? '单选题' : /判断/.test(typeText) ? '判断题' : '';
            const content = title.cloneNode(true);
            content.querySelectorAll('.title-tit,.right,.error').forEach(node => node.remove());
            const list = title.parentElement?.querySelector('.topic-list') || root.querySelector('.topic-list');
            const options = Array.from(list?.querySelectorAll('.topic-item') || []).filter(zhVisible).map((item, i) => {
                const label = zhText(item.querySelector('.topic-option-item')).replace(/[.．、:：\s]/g, '').toUpperCase();
                const option = zhRichContent(item.querySelector('.item-topic'));
                return { letter: label || String.fromCharCode(65 + i), ...option, element: item };
            });
            const question = zhRichContent(content);
            return { kind, title: question.text, images: question.images, options, root, doc: root.ownerDocument };
        }));
    }

    function zhQuestionSignature(questions) {
        return JSON.stringify(questions.map(question => [question.kind, zhContentIdentity({ text: question.title, images: question.images }),
            question.options.map(option => [option.letter, zhContentIdentity(option)])]));
    }

    function zhFindComponent(anchor, predicate) {
        // Vue 2 的组件根元素公开 __vue__；有界遍历，避免碰到其他课程/无限父子循环。
        const pending = [];
        const visited = new Set();
        for (let node = anchor; node; node = node.parentElement) if (node.__vue__) pending.push(node.__vue__);
        const root = anchor?.ownerDocument?.querySelector('#app');
        if (root?.__vue__) pending.push(root.__vue__);
        try {
            // 油猴隔离环境下，从 unsafeWindow 的文档读取页面自身的组件属性。
            const pageDoc = anchor?.ownerDocument === document ? pageWindow.document : anchor?.ownerDocument?.defaultView?.wrappedJSObject?.document;
            for (const element of pageDoc?.querySelectorAll('#app,#playTopic-dialog,.chapterScrollbar') || []) {
                if ((element.id === 'app' || element.contains(anchor) || anchor.contains(element)) && element.__vue__) pending.push(element.__vue__);
            }
        } catch (error) {
            /* 页面组件不可访问时保留只读建议，不构造跨上下文事件。 */
        }
        const matches = [];
        while (pending.length && visited.size < 200) {
            const vm = pending.shift();
            if (!vm || visited.has(vm) || vm._isDestroyed) continue;
            visited.add(vm);
            if (predicate(vm)) matches.push(vm);
            if (vm.$parent) pending.push(vm.$parent);
            if (Array.isArray(vm.$children)) pending.push(...vm.$children);
        }
        return matches.length === 1 ? matches[0] : null;
    }

    function zhVideoBinding(items, current) {
        const vm = zhFindComponent(current, candidate => Array.isArray(candidate.videoList) && typeof candidate.videoClick === 'function');
        if (!vm) return null;
        const records = [];
        vm.videoList.forEach((chapter, chapterIndex) => {
            if (!Array.isArray(chapter.videoLessons)) return;
            chapter.videoLessons.forEach((lesson, lessonIndex) => {
                const children = lesson.videoSmallLessons;
                if (Number(lesson.ishaveChildrenLesson) > 0 || Array.isArray(children) && children.length) {
                    if (Array.isArray(children)) children.forEach((small, smallIndex) => records.push({ video: small, args: [chapter, chapterIndex, lesson, lessonIndex, small, smallIndex] }));
                } else records.push({ video: lesson, args: [chapter, chapterIndex, lesson, lessonIndex] });
            });
        });
        if (records.length !== items.length || records.some((record, i) => !record.video.videoId || clean(record.video.name) !== zhItemTitle(items[i]))) return null;
        if (new Set(records.map(record => String(record.video.videoId))).size !== records.length) return null;
        if (String(records[items.indexOf(current)]?.video.videoId) !== String(vm.lastViewVideoId)) return null;
        return { vm, records };
    }

    function zhHtmlContent(html, doc) {
        const element = doc.createElement('div');
        element.innerHTML = String(html ?? '');
        return zhRichContent(element);
    }

    function zhContentMatches(html, content, doc) {
        return JSON.stringify(zhContentIdentity(zhHtmlContent(html, doc))) === JSON.stringify(zhContentIdentity(content));
    }

    function zhQuizBinding(question) {
        const vm = zhFindComponent(question.root, candidate => candidate.testDialog === true &&
            Array.isArray(candidate.topicInfo?.lessonTestQuestionUseInterfaceDtos) &&
            typeof candidate.topicClickQot === 'function' && typeof candidate.closeTest === 'function');
        if (!vm) return null;
        const rows = vm.topicInfo.lessonTestQuestionUseInterfaceDtos;
        const row = vm.pageList;
        const model = row?.testQuestion;
        const options = model?.questionOptions;
        if (!rows.includes(row) || !model?.questionId || !Array.isArray(options) || options.length !== question.options.length) return null;
        const type = model.questionType;
        const kind = /多选/.test(type?.name || '') ? '多选题' : /单选/.test(type?.name || '') ? '单选题' : /判断/.test(type?.name || '') ? '判断题' : '';
        if (kind !== question.kind || type.inputType !== (kind === '多选题' ? 'checkbox' : 'radio') ||
            !zhContentMatches(model.name, { text: question.title, images: question.images }, question.doc)) return null;
        if (options.some((option, i) => option.id == null || clean(option.sortUs).replace(/[.．、:：\s]/g, '').toUpperCase() !== question.options[i].letter ||
            !zhContentMatches(option.content, question.options[i], question.doc))) return null;
        if (new Set(options.map(option => String(option.id))).size !== options.length) return null;
        return { vm, rows, row, options };
    }

    function zhNextRender(vm) {
        return typeof vm.$nextTick === 'function' ? new Promise(resolve => vm.$nextTick(resolve)) : Promise.resolve();
    }

    function zhItemTitle(item) {
        const title = item?.querySelector('.catalogue_title');
        return clean(title?.getAttribute('title')) || zhText(title) || zhText(item?.querySelector('.hour'));
    }

    function zhItemKey(item, items) {
        if (!item) return '';
        return `${items.indexOf(item)}:${item.getAttribute('data-id') || item.id || ''}:${zhItemTitle(item)}`;
    }

    function zhCaptchaVisible(element) {
        if (!zhVisible(element)) return false;
        const view = element.ownerDocument.defaultView;
        // 腾讯 SDK 验证完成后保留 iframe，并把祖先设为透明、移到屏幕外。
        // 有布局框不代表正在展示验证码；只对验证码检查透明度和视口。
        for (let node = element; node; node = node.parentElement) {
            if (parseFloat(view.getComputedStyle(node).opacity) === 0) return false;
        }
        const width = view.innerWidth || element.ownerDocument.documentElement.clientWidth;
        const height = view.innerHeight || element.ownerDocument.documentElement.clientHeight;
        return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0 &&
            rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height);
    }

    function zhBlockingReason() {
        for (const doc of zhDocuments()) {
            // SDK 空容器本身不是验证界面，仅检测真正显示的验证码 iframe。
            if (Array.from(doc.querySelectorAll('iframe#tcaptcha_iframe_dy,iframe[src*="captcha"],iframe[id^="tcaptcha_"]')).some(zhCaptchaVisible)) {
                return '请在网页上完成人工验证';
            }
            if (Array.from(doc.querySelectorAll('.dialog-aberrant,.dialog .aberrant')).some(zhVisible)) {
                return '网页出现学习异常提示，请人工处理';
            }
            const modal = Array.from(doc.querySelectorAll('[role="dialog"],[aria-modal="true"],.el-dialog__wrapper,.el-message-box__wrapper'))
                .find(element => zhVisible(element) && zhText(element) && !zhQuizRoots().some(root => root === element || root.contains(element) || element.contains(root)));
            if (modal) return '网页弹窗等待处理：' + truncate(zhText(modal), 70);
        }
        return '';
    }

    function createZhihuishuPlayer() {
        const app = {
            _videoEl: null,
            _boundVideo: null,
            _handlers: null,
            _timer: null,
            _destroyed: true,
            _tickBusy: false,
            _wantPlay: true,
            _playingIntent: false,
            _playBusy: false,
            _playRetries: 0,
            _nextPlayAt: 0,
            _endedAt: 0,
            _pending: null,
            _advanceFailed: false,
            _activeKey: '',
            _blockedReason: '',
            _resumeAfterBlock: false,
            _completed: false,
            _quizToken: null,
            _quizCache: new Map(),
            _quizResume: false,
            _quizClosedRows: null,
            _cellData: { cells: 0, currentCellIndex: 0, currentNCellIndex: 0, currentVideoTitle: '' },
            run() {
                this._destroyed = false;
                log('success', '=== 智慧树共享课适配已启动 ===');
                this._timer = setInterval(() => this._tick(), 1000);
                this._tick();
            },
            _getVideoEl() {
                for (const doc of zhDocuments()) {
                    const preferred = doc.querySelector('video#vjs_container_html5_api');
                    if (preferred?.isConnected) return preferred;
                    const videos = Array.from(doc.querySelectorAll('video')).filter(zhVisible);
                    if (videos.length === 1) return videos[0];
                }
                return null;
            },
            _currentStepTitle() {
                if (this._blockedReason) return '等待处理';
                return this._videoEl ? '智慧树视频' : '等待播放器';
            },
            _unbindVideo() {
                if (this._boundVideo && this._handlers) {
                    for (const [event, fn] of Object.entries(this._handlers)) this._boundVideo.removeEventListener(event, fn);
                    unlockRateLock(this._boundVideo);
                }
                this._boundVideo = null;
                this._handlers = null;
            },
            _bindVideo(video) {
                if (this._boundVideo === video) return;
                this._unbindVideo();
                this._videoEl = video;
                this._boundVideo = video;
                this._endedAt = 0;
                this._wantPlay = true;
                this._playingIntent = false;
                this._playRetries = 0;
                if (!video) return;
                this._handlers = {
                    ended: () => {
                        if (!this._destroyed && this._videoEl === video && !this._pending && !this._advanceFailed) {
                            this._endedAt ||= Date.now();
                            this._wantPlay = false;
                            this._playingIntent = false;
                        }
                    },
                    play: () => {
                        if (!this._destroyed) {
                            this._wantPlay = false;
                            this._playingIntent = true;
                        }
                    },
                    pause: () => {
                        if (this._destroyed) return;
                        // testDotClick 在同一异步回调先 pause 再打开弹题；媒体 pause 事件随后派发。
                        // 只有匹配真实组件和可见题目的暂停才保留播放意图，人工提前暂停会清除它。
                        const questions = zhQuestions();
                        if (this._playingIntent && questions.length === 1 && zhQuizBinding(questions[0])) {
                            this._quizResume = true;
                            return;
                        }
                        this._playingIntent = false;
                        this._wantPlay = false;
                    },
                    loadedmetadata: () => {
                        if (!this._destroyed) {
                            this._endedAt = 0;
                            this._wantPlay = true;
                            this._playRetries = 0;
                            this._advanceFailed = false;
                            this._completed = false;
                        }
                    },
                };
                for (const [event, fn] of Object.entries(this._handlers)) video.addEventListener(event, fn);
            },
            _syncDirectory() {
                const items = zhVideoItems();
                const selected = items.filter(item => item.classList.contains('current_play'));
                const current = selected.length === 1 ? selected[0] : null;
                const key = zhItemKey(current, items);
                if (key && this._activeKey && key !== this._activeKey && !this._pending) {
                    this._endedAt = 0;
                    this._wantPlay = true;
                    this._advanceFailed = false;
                    this._completed = false;
                }
                this._activeKey = key;
                this._cellData = {
                    cells: items.length,
                    currentCellIndex: Math.max(0, items.indexOf(current)),
                    currentNCellIndex: 0,
                    currentVideoTitle: zhItemTitle(current),
                };
                return { items, current, key };
            },
            async _tryPlay(video) {
                if (this._playBusy || !this._wantPlay || Date.now() < this._nextPlayAt || video.readyState < 2 || video.error) return;
                this._playBusy = true;
                try {
                    await video.play();
                    if (this._destroyed) {
                        // 重启后旧实例不能暂停新实例正在使用的同一个视频。
                        if (!state.app || state.app === this) video.pause();
                        return;
                    }
                    this._wantPlay = false;
                    this._playRetries = 0;
                    setMode('running');
                    setActivity('视频播放中；暂停操作由网页和你控制');
                } catch (error) {
                    if (this._destroyed || this._videoEl !== video) return;
                    if (error?.name === 'NotAllowedError') {
                        this._wantPlay = false;
                        setActivity('浏览器阻止自动播放，请手动点击网页播放按钮');
                        log('warn', '浏览器需要一次手动播放操作，已停止自动重试');
                    } else if (isTransientPlayError(error) && ++this._playRetries <= 3) {
                        this._nextPlayAt = Date.now() + 2000;
                    } else {
                        this._wantPlay = false;
                        setActivity('播放失败，请在网页手动播放或重新开始');
                        log('warn', `智慧树播放失败：${error.message || error}`);
                    }
                } finally {
                    this._playBusy = false;
                }
            },
            async _tick() {
                if (this._destroyed || this._tickBusy) return;
                this._tickBusy = true;
                try {
                    if (location.hostname !== 'studyvideoh5.zhihuishu.com' || !/^\/stuStudy(?:\/|$)/.test(location.pathname)) {
                        this.destroy();
                        setActivity('已离开智慧树共享课播放页');
                        setMode('idle');
                        return;
                    }
                    const video = this._getVideoEl();
                    if (video !== this._videoEl) this._bindVideo(video);
                    const directory = this._syncDirectory();
                    const blocked = zhBlockingReason();
                    if (blocked) {
                        this._quizToken = null;
                        if (!this._blockedReason) this._resumeAfterBlock = Boolean(video && (!video.paused || this._wantPlay));
                        if (blocked !== this._blockedReason) log('warn', blocked);
                        this._blockedReason = blocked;
                        if (video && !video.paused) video.pause();
                        setMode('waiting');
                        setActivity(blocked);
                        return;
                    }
                    if (this._blockedReason) {
                        this._blockedReason = '';
                        if (this._resumeAfterBlock) this._wantPlay = true;
                        this._resumeAfterBlock = false;
                        setMode('running');
                    }
                    if (this._handleQuiz(video)) return;
                    if (!video) {
                        setMode('waiting');
                        setActivity('等待智慧树播放器加载，请进入共享课视频页');
                        return;
                    }
                    if (this._pending) {
                        const changedItem = directory.key && directory.key !== this._pending.from;
                        const changedSource = (video.currentSrc || video.src) !== this._pending.source;
                        if ((changedItem || changedSource) && !video.ended && video.currentTime < Math.max(1, video.duration - 1)) {
                            this._pending = null;
                            this._endedAt = 0;
                            this._wantPlay = true;
                            this._advanceFailed = false;
                        } else {
                            if (Date.now() - this._pending.at > 15000 && !this._pending.warned) {
                                this._pending.warned = true;
                                log('warn', '切换尚未确认，已停止重复点击；请检查网页或重新开始');
                                setActivity('等待下一视频加载；不会重复点击目录');
                            }
                            return;
                        }
                    }
                    if (this._completed || this._advanceFailed) return;
                    applyPlaybackRate(video);
                    if (video.ended) this._endedAt ||= Date.now();
                    if (this._endedAt) {
                        if (!settings.autoNext) setActivity('视频已结束，自动跳节已关闭');
                        else if (Date.now() - this._endedAt >= 2000) this.nextUnit(false);
                        return;
                    }
                    // 不把暂停、快到结尾、失焦或切换标签当成完成，也不抢回用户的暂停操作。
                    if (this._wantPlay && !document.hidden) await this._tryPlay(video);
                } catch (error) {
                    if (!this._destroyed) {
                        this._wantPlay = false;
                        setMode('error');
                        setActivity('适配错误：' + (error.message || error));
                        log('error', '智慧树适配错误：' + (error.message || error));
                    }
                } finally {
                    this._tickBusy = false;
                }
            },
            nextUnit(manual = true) {
                if (this._destroyed || this._pending || (!manual && !settings.autoNext)) return;
                if (zhQuizRoots().length) { setActivity('弹题作答期间不切换视频'); return; }
                const blocked = zhBlockingReason();
                if (blocked) { setActivity(blocked); return; }
                const { items, current, key } = this._syncDirectory();
                if (!current) {
                    this._advanceFailed = true;
                    setActivity('无法唯一识别当前视频，请在网页先选择一个小节');
                    return;
                }
                const next = items.slice(items.indexOf(current) + 1).find(item => !item.querySelector('b.time_icofinish'));
                if (!next) {
                    this._completed = true;
                    setMode('idle');
                    setActivity('后续视频已完成或已到目录末尾；章节测验请在网页处理');
                    log('success', '当前视频目录没有后续未完成的视频');
                    return;
                }
                if (next.matches('[disabled],[aria-disabled="true"],.locked,.lock,.disabled') || next.querySelector('.icon-lock,[class~="locked"]')) {
                    this._advanceFailed = true;
                    setActivity('下一视频尚未解锁，请在网页检查先修任务');
                    return;
                }
                next.scrollIntoView({ block: 'nearest' });
                const binding = zhVideoBinding(items, current);
                if (!binding) {
                    this._advanceFailed = true;
                    setActivity('无法验证课程组件，请在网页手动选择下一视频');
                    log('warn', '目录与课程组件无法唯一对应，未模拟点击目录');
                    return;
                }
                this._pending = { from: key, source: this._videoEl?.currentSrc || this._videoEl?.src || '', at: Date.now(), warned: false };
                this._wantPlay = false;
                this._endedAt = 0;
                this._completed = false;
                try {
                    // 与播放器自身 videoNext 一样，传原始课程对象，不构造鼠标事件。
                    binding.vm.videoClick(...binding.records[items.indexOf(next)].args);
                    log('info', `切换视频：${zhItemTitle(next)}；等待网页保存进度和加载播放器`);
                    setActivity('正在切换下一视频…');
                } catch (error) {
                    this._advanceFailed = true;
                    this._pending = null;
                    log('error', '课程组件切换失败：' + (error.message || error));
                    setActivity('切换失败，请在网页手动选择视频');
                }
            },
            cancelQuizContext() {
                // 设置即使在一次轮询间隔内改回原值，也不能重新激活旧请求。
                this._quizToken = null;
            },
            _handleQuiz(video) {
                const roots = zhQuizRoots();
                const questions = zhQuestions();
                if (!roots.length) {
                    if (this._quizToken || this._quizResume) {
                        this._quizToken = null;
                        if (this._quizResume) this._wantPlay = true;
                        this._quizResume = false;
                        this._quizClosedRows = null;
                    }
                    return false;
                }
                if (!this._quizToken) this._quizResume ||= Boolean(video && (!video.paused || this._wantPlay));
                if (video && !video.paused) video.pause();
                setMode('waiting');
                const signature = zhQuestionSignature(questions);
                const apiKey = currentApiKey();
                const binding = questions.length === 1 ? zhQuizBinding(questions[0]) : null;
                if (this._quizToken?.signature !== signature || this._quizToken?.key !== apiKey || this._quizToken?.enabled !== settings.autoQuiz ||
                    this._quizToken.root !== roots[0] || this._quizToken.video !== video || this._quizToken.activeKey !== this._activeKey ||
                    this._quizToken.binding?.row !== binding?.row || this._quizToken.binding?.rows !== binding?.rows || this._quizToken.binding?.vm !== binding?.vm) {
                    this._quizToken = { signature, key: apiKey, enabled: settings.autoQuiz, root: roots[0], video, activeKey: this._activeKey, binding, started: false, attempts: 0, retryAt: 0 };
                }
                const token = this._quizToken;
                if (!settings.autoQuiz || !apiKey) {
                    setActivity(settings.autoQuiz ? '弹题已暂停，请填写 DeepSeek API Key 或手动作答' : '弹题已暂停，自动答题已关闭，请手动作答');
                    return true;
                }
                if (roots.length !== 1 || questions.length !== 1 || questions.some(q => !q.kind || !q.title || q.options.length < 2 || q.options.some(o => !o.text || !/^[A-H]$/.test(o.letter)) || new Set(q.options.map(o => o.letter)).size !== q.options.length)) {
                    setActivity('弹题类型或选项无法确认，请在网页手动作答');
                    return true;
                }
                // 去重和失败预算只属于当前上下文；取消后的同题可以重新请求。
                if (!token.started && (!token.retryAt || Date.now() >= token.retryAt)) {
                    token.started = true;
                    token.attempts++;
                    token.retryAt = 0;
                    this._solveQuiz(questions, token);
                }
                return true;
            },
            _quizIsCurrent(token) {
                if (this._destroyed || state.app !== this || this._quizToken !== token || !settings.autoQuiz || currentApiKey() !== token.key ||
                    this._getVideoEl() !== token.video || this._syncDirectory().key !== token.activeKey || zhBlockingReason()) return false;
                const roots = zhQuizRoots(), questions = zhQuestions();
                if (roots.length !== 1 || roots[0] !== token.root || zhQuestionSignature(questions) !== token.signature) return false;
                if (token.binding) {
                    const binding = questions.length === 1 ? zhQuizBinding(questions[0]) : null;
                    if (!binding || binding.vm !== token.binding.vm || binding.row !== token.binding.row || binding.rows !== token.binding.rows) return false;
                }
                return true;
            },
            async _solveQuiz(questions, token) {
                try {
                    const cached = this._quizCache.get(token.signature);
                    if (!cached && questions.some(questionHasImages)) {
                        const count = questions.reduce((sum, q) => sum + q.images.length + q.options.reduce((n, o) => n + o.images.length, 0), 0);
                        log('info', `图文识别：题干与选项共 ${count} 张图片，按题号和选项字母发送至 DeepSeek`);
                    }
                    const result = cached || await askAnswers(questions, () => this._quizIsCurrent(token));
                    if (!this._quizIsCurrent(token)) return;
                    this._quizCache.set(token.signature, result);
                    const letters = result.answers.get(1);
                    if (token.binding) {
                        await this._applyQuizAnswer(questions[0], letters, token);
                        return;
                    }
                    log('info', `AI 建议：${letters.join('、')}；请在网页选择并关闭弹题`);
                    setActivity(`AI 建议：${letters.join('、')}；请手动选择选项并关闭弹题`);
                } catch (error) {
                    if (!this._quizIsCurrent(token)) return;
                    if (!this._quizCache.has(token.signature) && token.attempts < 3 && /网络请求失败|请求超时|429|HTTP 5\d\d/.test(error.message || '')) {
                        token.started = false;
                        token.retryAt = Date.now() + token.attempts * 2000;
                        log('warn', `智慧树弹题请求失败：${error.message}；冷却后重试（最多 3 次）`);
                        setActivity('弹题请求暂时失败，等待冷却后重试…');
                        return;
                    }
                    log('error', `智慧树弹题作答停止：${error.message || error}`);
                    setActivity('弹题作答停止：' + (error.message || error));
                }
            },
            async _applyQuizAnswer(question, letters, token) {
                const { vm, rows, row, options } = token.binding;
                const desired = new Set(letters);
                // 单选只需点目标，多选则先清除已有的多余选择。
                const toChange = question.kind === '多选题'
                    ? options.filter((option, i) => Boolean(option.isClick) !== desired.has(question.options[i].letter))
                    : options.filter((option, i) => desired.has(question.options[i].letter) && !option.isClick);
                for (const option of toChange) {
                    if (!this._quizIsCurrent(token)) return;
                    vm.topicClickQot(option, 2);
                    await zhNextRender(vm);
                }
                if (!this._quizIsCurrent(token)) return;
                const expectedIds = options.filter((option, i) => desired.has(question.options[i].letter)).map(option => String(option.id));
                const selectedIds = options.filter(option => option.isClick).map(option => String(option.id));
                const storedIds = Array.isArray(row.answerStu) ? row.answerStu.map(String) : String(row.answerStu || '').split(',').filter(Boolean);
                if (!row.isCheck || expectedIds.length !== selectedIds.length || expectedIds.some(id => !selectedIds.includes(id) || !storedIds.includes(id)) || storedIds.length !== expectedIds.length) throw new Error('网页未确认选项状态，请手动核对');
                const currentOptions = zhQuestions()[0]?.options || [];
                if (currentOptions.length !== options.length || currentOptions.some((option, i) => Boolean(option.element.querySelector('.item-topic.active,.topic-option-item.active')) !== desired.has(question.options[i].letter))) throw new Error('网页选项显示未更新，请手动核对');
                log('info', `弹题已选择：${letters.join('、')}；保存由网页原有接口处理`);
                if (rows.every(item => item.isCheck === true)) {
                    if (this._quizClosedRows === rows || !this._quizIsCurrent(token)) return;
                    this._quizClosedRows = rows;
                    // closeTest 同时用于 el-dialog 的 before-close，接收普通完成回调。
                    vm.closeTest(() => {});
                    await zhNextRender(vm);
                    if (this._destroyed || state.app !== this || this._quizToken !== token) return;
                    setActivity('已请求关闭弹题，等待网页确认');
                } else {
                    if (typeof vm.pageeClick !== 'function') throw new Error('未找到弹题分页方法，请手动切题');
                    const index = rows.findIndex(item => item.isCheck !== true);
                    if (!this._quizIsCurrent(token)) return;
                    vm.pageeClick(index + 1);
                    await zhNextRender(vm);
                    if (this._destroyed || state.app !== this || this._quizToken !== token) return;
                    setActivity('已作答当前题，等待下一弹题显示');
                }
            },
            inspectQuiz() {
                return zhQuestions().map((q, i) => ({ id: i + 1, type: q.kind || '未知题型', question: q.title,
                    options: q.options.map(o => `${o.letter}. ${o.text}`), imageCount: q.images.length + q.options.reduce((sum, o) => sum + o.images.length, 0) }));
            },
            destroy() {
                this._destroyed = true;
                this._quizToken = null;
                this._wantPlay = false;
                this._playingIntent = false;
                if (this._timer) clearInterval(this._timer);
                this._timer = null;
                this._pending = null;
                this._unbindVideo();
                this._videoEl = null;
            },
        };
        return app;
    }

    function createPlayer() {
        const app = {
            configs: {
                autoplay: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 500,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                autoAdvanceNoVideo: false,
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _currentRetryCount: 0,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _chapterAdvanceTimes: 0,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: '',
            },
            get cellData() {
                return this._cellData;
            },
            run() {
                this._destroyed = false;
                log('success', '=== 学习通自动刷课已启动 ===');
                this._nextUnitPending = false;
                this._chapterAdvanceTimes = 0;
                this._getTreeContainer();
                this._initCellData();
                log('info', `当前学习步骤：${this._currentStepTitle() || '等待页面加载'}`);
                this._videoEl = null;
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this._startInlineQuizWatch();
                this.play();
            },
            nextUnit() {
                if (this._nextUnitPending) {
                    log('warn', '已有小节切换正在进行，忽略重复请求');
                    return;
                }
                this._nextUnitPending = true;
                this._clearCheckInterval();
                try {
                    const el = this._getTreeContainer();
                    const cells = el.children('ul').children('li');
                    const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    if (nCells.length > this._cellData.currentNCellIndex + 1) {
                        const nextNIndex = this._cellData.currentNCellIndex + 1;
                        this.playCurrentIndex(nCells.get(nextNIndex));
                    } else {
                        const nextIndex = this._cellData.currentCellIndex + 1;
                        if (nextIndex >= cells.length) {
                            log('success', '本课程学习完成了');
                            setActivity('全部小节已完成');
                            setMode('idle');
                            return;
                        }
                        this._cellData.currentCellIndex = nextIndex;
                        this._cellData.currentNCellIndex = 0;
                        this.playCurrentIndex();
                    }
                } catch (error) {
                    this._nextUnitPending = false;
                    log('error', `切换下一小节失败：${error.message || error}`);
                }
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                }, this.configs.videoCheckInterval);
            },
            _startInlineQuizWatch() {
                if (this._inlineQuizTimer) return;
                this._inlineQuizTimer = setInterval(() => this._maybeSolveInlineQuiz(), 500);
            },
            _maybeSolveInlineQuiz() {
                if (this._inlineQuizBusy || this._destroyed) return;
                try {
                    if (this._isChapterTest()) return;
                    const questions = extractQuestions(true);
                    const docs = deepDocuments();
                    let submitRoot = null;
                    let submit = null;
                    for (const doc of docs) {
                        const candidate = findButtonContaining(doc, '提交') || findButtonContaining(doc, '交卷');
                        if (candidate && visible(candidate)) {
                            submitRoot = doc;
                            submit = candidate;
                            break;
                        }
                    }
                    if (!submit) return;
                    if (!questions.length) {
                        const fallback = extractQuestionNearSubmit(submit);
                        if (fallback) questions.push(fallback);
                    }
                    if (!questions.length) {
                        const container = submit.parentElement?.parentElement;
                        const text = clean(container?.innerText || '');
                        if (text && !this._inlineStructureWarned) {
                            this._inlineStructureWarned = true;
                            log('warn', `检测到提交按钮但题目结构未识别：${truncate(text, 80)}`);
                        }
                        return;
                    }
                    if (!currentApiKey()) {
                        if (!this._inlineKeyWarned) {
                            this._inlineKeyWarned = true;
                            log('warn', '视频弹题需要 DeepSeek API Key：请在面板顶部输入并保存，脚本会自动继续');
                        }
                        const pendingVideo = this._getVideoEl();
                        if (pendingVideo && !pendingVideo.paused) {
                            try {
                                pendingVideo.pause();
                            } catch (error) {
                                /* 忽略 */
                            }
                        }
                        return;
                    }
                    this._inlineKeyWarned = false;
                    this._inlineDetectedAt = Date.now();
                    const signature = questions.map((question) => `${question.kind}:${question.title}:${question.options.length}`).join('|');
                    const attempts = this._inlineAttempts.get(signature) || 0;
                    if (attempts >= 3) return;
                    this._inlineAttempts.set(signature, attempts + 1);
                    const video = this._getVideoEl();
                    if (video && !video.paused) {
                        try {
                            video.pause();
                            log('info', '已暂停视频，等待弹题作答');
                            this._inlinePauseCheckTimer = setTimeout(() => {
                                if (this._inlineQuizBusy && !video.paused) {
                                    log('warn', '弹题期间播放器又自动恢复了播放，倒计时可能继续');
                                }
                            }, 700);
                        } catch (error) {
                            /* 忽略 */
                        }
                    }
                    this._inlineQuizBusy = true;
                    this._solveInlineQuiz(questions, submitRoot, submit, signature);
                } catch (error) {
                    log('error', `视频弹题检测失败：${error.message || error}`);
                }
            },
            async _solveInlineQuiz(questions, submitRoot, submit, signature) {
                try {
                    log('info', `检测到视频弹题（${questions.length} 道），开始作答`);
                    const first = questions[0];
                    const decoder = fontDecoderCache.decoder;
                    if (decoder) {
                        for (const question of questions) {
                            question.title = decoder.decode(question.title);
                            for (const option of question.options) option.text = decoder.decode(option.text);
                        }
                        log('info', '已用缓存的字体映射还原视频弹题');
                    }
                    const { answers } = await (async () => {
                        const cached = this._inlineAnswerCache.get(signature);
                        if (cached) {
                            log('info', '使用已缓存的弹题答案');
                            return { answers: cached };
                        }
                        const result = await askAnswers(questions);
                        this._inlineAnswerCache.set(signature, result.answers);
                        return result;
                    })();
                    for (let index = 0; index < questions.length; index++) {
                        log('info', `弹题 ${index + 1}. [${questions[index].kind}] ${truncate(questions[index].title, 34)} → ${answers.get(index + 1).join('')}`);
                    }
                    if (typeof this._selectAnswers === 'function') {
                        await this._selectAnswers(questions, answers);
                    } else {
                        for (let index = 0; index < questions.length; index++) {
                            for (const letter of answers.get(index + 1)) {
                                const option = questions[index].options.find((item) => item.letter === letter);
                                if (option?.element?.isConnected) {
                                    option.element.click();
                                    await sleep(120);
                                }
                            }
                        }
                    }
                    const currentSubmit = findButtonContaining(submitRoot, '提交') ||
                        findButtonContaining(submitRoot, '交卷') || submit;
                    if (!currentSubmit || !currentSubmit.isConnected) throw new Error('弹题已关闭（可能超时），未提交');
                    const minDelay = 400 + Math.random() * 300;
                    const elapsed = Date.now() - (this._inlineDetectedAt || Date.now());
                    const waitMs = Math.max(0, minDelay - elapsed);
                    if (waitMs > 0) {
                        log('info', `等待 ${(waitMs / 1000).toFixed(1)} 秒后提交，避免判定答题过快`);
                        await sleep(waitMs);
                    }
                    await waitFor(() => !currentSubmit.disabled, 2000, 100);
                    if (this._inlinePauseCheckTimer) {
                        clearTimeout(this._inlinePauseCheckTimer);
                        this._inlinePauseCheckTimer = null;
                    }
                    currentSubmit.scrollIntoView({ block: 'center' });
                    const beforeTime = Number(this._getVideoEl()?.currentTime || 0);
                    currentSubmit.click();
                    log('info', '视频弹题已提交');
                    await sleep(300);
                    if (visible(currentSubmit)) confirmInlineSubmit(submitRoot);
                    const afterTime = Number(this._getVideoEl()?.currentTime || 0);
                    if (afterTime < beforeTime - 1.5) {
                        log('warn', `提交后视频回退 ${(beforeTime - afterTime).toFixed(1)} 秒，可能是平台回放或判定答题过快`);
                    }
                    const closed = await waitFor(() => !visible(currentSubmit) ||
                        (!findButtonContaining(submitRoot, '提交') && !findButtonContaining(submitRoot, '交卷')), 5000);
                    if (!closed) log('warn', '视频弹题提交后仍显示，请手动核对');
                } catch (error) {
                    log('error', `视频弹题作答失败：${error.message || error}`);
                } finally {
                    this._inlineQuizBusy = false;
                    if (!this._destroyed) setTimeout(() => this.play(), 300);
                }
            },
            _tryResumePlayback(reason) {
                if (this._inlineQuizBusy) return;
                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return;
                this._guardLastResumeTs = now;
                const video = this._getVideoEl();
                if (!video || !this._isPlaying || this._playPending) return;
                if (Number(video.readyState) < 2) return;
                applyPlaybackRate(video);
                video.muted = true;
                video.defaultMuted = true;
                video.volume = 0;
                video.play().catch(() => {
                    video.muted = true;
                    video.play().catch((error) => log('error', `恢复播放失败：${error.message || error}`));
                });
            },
            _checkVideoStatus() {
                try {
                    const video = this._getVideoEl();
                    if (!video) return;
                    if (this._inlineQuizBusy) return;
                    applyPlaybackRate(video);
                    video.muted = true;
                    video.defaultMuted = true;
                    video.volume = 0;
                    if (video.paused) {
                        /* 页面已自行暂停，保持暂停 */
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
                                this._tryResumePlayback('no-progress');
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }
                    if (video.ended && this._isPlaying) {
                        this._isPlaying = false;
                        setTimeout(() => this.nextUnit(), 400);
                    }
                } catch (error) {
                    log('error', `视频状态检查失败：${error.message || error}`);
                }
            },
            _tryTimes: 0,
            _stepAdvanceTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _delayedNextUnitTimer: null,
            _playPending: null,
            _transientPlayAttempts: 0,
            _inlineQuizTimer: null,
            _inlineQuizBusy: false,
            _inlineAttempts: new Map(),
            _inlineAnswerCache: new Map(),
            _inlineStructureWarned: false,
            _inlineKeyWarned: false,
            _inlineDetectedAt: 0,
            _inlinePauseCheckTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                if (this._destroyed || this._inlineQuizBusy) return;
                if (this._playPending) return this._playPending;
                this._playPending = this._playOnce().finally(() => {
                    this._playPending = null;
                });
                return this._playPending;
            },
            async _playOnce() {
                try {
                    if (this._isChapterTest()) {
                        this._videoEl = null;
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        setMode('running');
                        this._advanceChapterTest();
                        return;
                    }
                    const el = this._getVideoEl();
                    if (el == null) {
                        if (this._currentStepTitle() === '视频') throw new Error('视频组件尚未加载完成');
                        if (this._advanceLearningStep()) {
                            log('info', '当前不在视频页，已尝试切到“视频”页签，1 秒后重试');
                            setTimeout(() => this.play(), 1000);
                            return;
                        }
                        if (this._isChapterTest()) {
                            this._advanceChapterTest();
                            return;
                        }
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        setMode('idle');
                        if (this.configs.autoAdvanceNoVideo) {
                            log('warn', '当前小节未发现视频，按配置切换到下一小节');
                            this.nextUnit();
                        } else {
                            log('warn', '当前小节未发现视频或可识别的学习步骤，已安全停止');
                            setActivity('当前小节未发现视频');
                        }
                        return;
                    }
                    this._isPlaying = true;
                    this._videoEventHandle();
                    try {
                        el.muted = true;
                        el.defaultMuted = true;
                        el.volume = 0;
                        applyPlaybackRate(el);
                        await el.play();
                        this._tryTimes = 0;
                        this._transientPlayAttempts = 0;
                        applyPlaybackRate(el);
                        setMode('running');
                        const actualRate = Number(el.playbackRate) || 1;
                        log('success', `视频开始播放：${truncate(this._cellData.currentVideoTitle || '未命名', 24)}（${actualRate}x）`);
                        setActivity('视频播放中');
                        this._startVideoMonitoring();
                    } catch (playError) {
                        if (isTransientPlayError(playError)) {
                            await this._handleTransientPlayError(el);
                            return;
                        }
                        log('error', `视频播放失败：${playError.message || playError}`);
                        this._handlePlayError(playError);
                    }
                } catch (error) {
                    if (this._tryTimes >= this.configs.maxRetries) {
                        log('error', `视频播放失败，已达最大重试次数：${error.message || error}`);
                        this._clearCheckInterval();
                        setActivity('播放失败，请检查页面');
                        return;
                    }
                    this._tryTimes++;
                    log('warn', `${this.configs.retryInterval / 1000} 秒后重试播放 (${this._tryTimes}/${this.configs.maxRetries})`);
                    setTimeout(() => this.play(), this.configs.retryInterval);
                }
            },
            async _handleTransientPlayError(el) {
                this._transientPlayAttempts = (this._transientPlayAttempts || 0) + 1;
                if (this._transientPlayAttempts > 8) {
                    this._isPlaying = false;
                    this._clearCheckInterval();
                    log('error', '视频资源长时间未就绪，已停止重试；请检查播放器或刷新页面');
                    setActivity('视频资源未就绪');
                    setMode('error');
                    return;
                }
                log('info', `视频还在加载，等待就绪后继续播放（${this._transientPlayAttempts}/8）`);
                setActivity('等待视频加载…');
                await sleep(500);
                await waitForMediaReady(el, 8000);
                if (!el.isConnected) {
                    this._videoEl = null;
                    setTimeout(() => this.play(), 200);
                    return;
                }
                setTimeout(() => this.play(), 250);
            },
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) return true;
                const currentStepTitle = this._currentStepTitle();
                if (currentStepTitle === '章节测验' || currentStepTitle === '视频') return false;
                const clickElement = (element, label) => {
                    if (!element) return false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    log('info', `尝试点击${label}`);
                    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                };
                const videoTab = $('.prev_white:visible').filter((_, element) => {
                    const text = ($(element).text() || '').replace(/\s+/g, '');
                    return text === '2视频' || text === '视频';
                }).get(0);
                if (clickElement(videoTab, '“视频”页签')) return true;
                return false;
            },
            _currentStepTitle() {
                const cardsFrame = Array.from(document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
                    .find((frame) => frame.getClientRects().length > 0);
                if (cardsFrame) {
                    const num = new URL(cardsFrame.getAttribute('src'), location.href).searchParams.get('num');
                    if (num === '0') return '视频';
                    if (num === '1') return '章节测验';
                }
                const prevTitle = document.getElementsByClassName('prev_title')[0];
                const text = prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';
                return text === '视频' || text === '章节测验' ? text : '';
            },
            _isChapterTest() {
                return this._currentStepTitle() === '章节测验';
            },
            _advanceChapterTest() {
                if (this._chapterAdvanceTimes >= 3) {
                    log('error', '章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后点击“开始”');
                    setMode('error');
                    return;
                }
                const nextButton = $('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
                if (!nextButton) {
                    log('warn', '未找到章节测验的下一步按钮，已停止');
                    return;
                }
                this._chapterAdvanceTimes++;
                const previousStep = this._currentStepTitle();
                clickElement(nextButton);
                const started = Date.now();
                const timer = setInterval(() => {
                    if (this._currentStepTitle() !== previousStep || Date.now() - started > 8000) {
                        clearInterval(timer);
                        this.play();
                        return;
                    }
                    if (Date.now() - started > 300) confirmNextStepDialog(nextButton);
                }, 250);
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) return;
                this._stepNavigationBound = true;
                const reenterVideoMode = () => {
                    this._videoEl = null;
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    setTimeout(() => {
                        try {
                            this._initCellData();
                        } catch (error) {
                            /* 页面尚未就绪 */
                        }
                        this.play();
                    }, 800);
                };
                $(document).off('click.xuexitongPlayerV4', '.prev_white').on('click.xuexitongPlayerV4', '.prev_white', (event) => {
                    const text = ($(event.currentTarget).text() || '').replace(/\s+/g, '');
                    if (text.includes('视频') || text.includes('章节测验')) {
                        log('info', `检测到步骤切换：${text}，重新识别页面`);
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                if (this._tryTimes >= this.configs.maxRetries) {
                    log('error', `视频播放失败，已达最大重试次数：${error.message || error}`);
                    this._isPlaying = false;
                    this._clearCheckInterval();
                    setActivity('播放失败，请检查页面');
                    return;
                }
                this._tryTimes++;
                log('warn', `${this.configs.retryInterval / 1000} 秒后重试播放 (${this._tryTimes}/${this.configs.maxRetries})`);
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = setTimeout(() => {
                    this._delayedNextUnitTimer = null;
                    this.play();
                }, this.configs.retryInterval);
            },
            playCurrentIndex(nCell) {
                this._nextUnitPending = false;
                if (!nCell) {
                    const el = this._getTreeContainer();
                    const cells = el.children('ul').children('li');
                    const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    nCell = nCells.get(this._cellData.currentNCellIndex);
                }
                const $nCell = $(nCell);
                const clickableSpan = $nCell.find('.posCatalog_name')[0];
                if (!clickableSpan) {
                    log('error', '找不到可点击的课程节点，播放下一个视频失败');
                    return;
                }
                log('info', `切换到：${$(clickableSpan).attr('title') || '未知标题'}`);
                $(clickableSpan).click();
                this._videoEl = null;
                this._isPlaying = false;
                setTimeout(() => {
                    try {
                        this._initCellData();
                    } catch (error) {
                        log('warn', '课程目录尚未刷新，稍后自动重试');
                        return;
                    }
                    if (this.configs.autoplay) this.play();
                }, 1200);
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children('ul').children('li');
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;
                cells.each((index, element) => {
                    const nCells = $(element).find('.posCatalog_select:not(.firstLayer)');
                    nCellCounts += nCells.length;
                    nCells.each((nIndex, nElement) => {
                        const $el = $(nElement);
                        if ($el.hasClass('posCatalog_active')) {
                            this._cellData.currentCellIndex = index;
                            this._cellData.currentNCellIndex = nIndex;
                            foundCurrent = true;
                            const titleSpan = $el.find('.posCatalog_name')[0];
                            if (titleSpan) this._cellData.currentVideoTitle = $(titleSpan).attr('title');
                        }
                    });
                });
                this._cellData.nCells = nCellCounts;
                if (!foundCurrent && nCellCounts > 0) log('warn', '未找到当前激活的视频节点，可能需要手动选择');
            },
            _getTreeContainer() {
                if (!this._treeContainerEl) {
                    const el = $('#coursetree');
                    if (el.length <= 0) throw new Error('找不到视频列表（#coursetree），请确认已进入课程播放页');
                    this._treeContainerEl = el;
                }
                return this._treeContainerEl;
            },
            _getVideoEl() {
                if (this._videoEl && !this._videoEl.isConnected) {
                    this._detachVideoEvents();
                    this._videoEl = null;
                }
                if (!this._videoEl) {
                    try {
                        const findVideo = (frame, depth) => {
                            if (depth > 2) return null;
                            const frameDocument = frame.contentDocument || frame.contentWindow?.document;
                            if (!frameDocument) return null;
                            const $frameDocument = $(frameDocument);
                            const directVideo = $frameDocument.find('video#video_html5_api, video[id*="video_html5"]').get(0);
                            if (directVideo) return directVideo;
                            const nestedFrames = $frameDocument.find('iframe.ans-insertvideo-online, iframe[src*="video"]');
                            for (const nestedFrame of nestedFrames.toArray()) {
                                const nestedVideo = findVideo(nestedFrame, depth + 1);
                                if (nestedVideo) return nestedVideo;
                            }
                            return null;
                        };
                        for (const frame of $('iframe').toArray()) {
                            const video = findVideo(frame, 0);
                            if (video) {
                                this._videoEl = video;
                                video.muted = true;
                                video.defaultMuted = true;
                                video.volume = 0;
                                applyPlaybackRate(video);
                                break;
                            }
                        }
                    } catch (error) {
                        log('error', `获取视频元素失败：${error.message || error}`);
                        return null;
                    }
                }
                return this._videoEl || null;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) return;
                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                    ratechange: this._handleVideoRateChange.bind(this),
                };
                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
                el.addEventListener('ratechange', this._boundVideoHandlers.ratechange);
            },
            _detachVideoEvents() {
                if (!this._eventVideoEl || !this._boundVideoHandlers) return;
                this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                this._eventVideoEl.removeEventListener('ratechange', this._boundVideoHandlers.ratechange);
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
            },
            _handleVideoEnded() {
                log('success', `“${truncate(this._cellData.currentVideoTitle || '当前视频', 24)}”播放完成`);
                this._isPlaying = false;
                this._clearCheckInterval();
                setTimeout(() => this.nextUnit(), 400);
            },
            _handleVideoLoaded() {
                if (this.configs.autoplay && !this._isPlaying) this.play();
            },
            _handleVideoPlay() {
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const video = this._getVideoEl();
                this._guardLastTime = Number(video?.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            },
            _handleVideoPause() {
                if (this._inlineQuizBusy) return;
                if (!this._isPlaying) return;
                this._isPlaying = false;
                log('info', '视频已暂停');
            },
            _handleVideoRateChange() {
                const rate = Number(settings.rate) || 0;
                const video = this._videoEl;
                if (rate <= 0 || rateBlocked || !video) return;
                if (Math.abs(Number(video.playbackRate || 1) - rate) < 0.01) {
                    this._rateResets = 0;
                    return;
                }
                const now = Date.now();
                if (!this._rateResetAt || now - this._rateResetAt > 2000) this._rateResets = 0;
                this._rateResetAt = now;
                this._rateResets = (this._rateResets || 0) + 1;
                if (this._rateResets > 8) {
                    rateBlocked = true;
                    if (!this._rateWarned) {
                        this._rateWarned = true;
                        log('warn', `播放器反复重置倍速（实际 ${Number(video.playbackRate) || 1}x），已停止强制；可改用播放器自带倍速`);
                    }
                    return;
                }
                setTimeout(() => applyPlaybackRate(video), 0);
            },
            _bindPageGuards() {
                if (this._pageGuards) return;
                const preventPause = (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                };
                const resumePlaybackNow = () => this._tryResumePlayback('page-event');
                this._pageGuards = { preventPause, resumePlaybackNow };
                document.addEventListener('mouseleave', preventPause);
                window.addEventListener('mouseleave', preventPause);
                document.addEventListener('mouseout', preventPause);
                window.addEventListener('mouseout', preventPause);
                window.addEventListener('blur', resumePlaybackNow);
                document.addEventListener('visibilitychange', resumePlaybackNow);
            },
            destroy() {
                this._destroyed = true;
                if (this._inlineQuizTimer) {
                    clearInterval(this._inlineQuizTimer);
                    this._inlineQuizTimer = null;
                }
                this._inlineQuizBusy = false;
                this._isPlaying = false;
                this._clearCheckInterval();
                this._detachVideoEvents();
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                $(document).off('.xuexitongPlayerV4');
                this._stepNavigationBound = false;
                if (this._pageGuards) {
                    const { preventPause, resumePlaybackNow } = this._pageGuards;
                    document.removeEventListener('mouseleave', preventPause);
                    window.removeEventListener('mouseleave', preventPause);
                    document.removeEventListener('mouseout', preventPause);
                    window.removeEventListener('mouseout', preventPause);
                    window.removeEventListener('blur', resumePlaybackNow);
                    document.removeEventListener('visibilitychange', resumePlaybackNow);
                    this._pageGuards = null;
                }
            },
        };

        attachQuizAutomation(app);
        return app;
    }

    /* -------------------------------------------------------------- 面板 UI */

    const CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
            position: fixed;
            width: 372px;
            color-scheme: dark;
            color: #e7eaf2;
            font: 12.5px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
            background: linear-gradient(180deg, rgba(24,27,35,.98), rgba(15,17,23,.985));
            border: 1px solid rgba(255,255,255,.09);
            border-radius: 14px;
            box-shadow: 0 18px 48px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
            overflow: hidden;
            pointer-events: auto;
            user-select: none;
        }
        .head {
            display: flex; align-items: center; gap: 8px;
            padding: 10px 12px;
            background: rgba(255,255,255,.035);
            border-bottom: 1px solid rgba(255,255,255,.06);
            cursor: move;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #5b6472; flex: none; }
        .dot.running { background: #2ee6a8; box-shadow: 0 0 0 3px rgba(46,230,168,.16); }
        .dot.waiting { background: #ffc861; box-shadow: 0 0 0 3px rgba(255,200,97,.14); }
        .dot.error { background: #ff5d5d; box-shadow: 0 0 0 3px rgba(255,93,93,.16); }
        .title { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
        .ver { color: #6b7486; font-size: 10.5px; }
        .spacer { flex: 1; }
        .icon {
            width: 22px; height: 22px; line-height: 18px; text-align: center;
            border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.04);
            color: #aab3c5; border-radius: 7px; cursor: pointer; font-size: 14px; padding: 0;
        }
        .icon:hover { background: rgba(255,255,255,.1); color: #fff; }
        .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
        .panel.min .body { display: none; }
        .panel.min { width: 236px; }
        .row { display: flex; align-items: center; gap: 6px; }
        .keyrow input {
            flex: 1; min-width: 0;
            background: rgba(255,255,255,.06);
            border: 1px solid rgba(255,255,255,.1);
            border-radius: 8px;
            padding: 6px 8px;
            color: #e7eaf2;
            font: inherit;
            outline: none;
        }
        .keyrow input:focus { border-color: #4c8dff; box-shadow: 0 0 0 2px rgba(76,141,255,.18); }
        .keyrow input::placeholder { color: #687184; }
        .btn {
            border: 1px solid rgba(255,255,255,.1);
            background: rgba(255,255,255,.05);
            color: #dfe4ee;
            padding: 5px 10px;
            border-radius: 8px;
            cursor: pointer;
            font: inherit;
            white-space: nowrap;
        }
        .btn:hover { background: rgba(255,255,255,.1); }
        .btn:active { transform: translateY(1px); }
        .btn.primary { background: linear-gradient(180deg, #4479ff, #2f5fe0); border-color: #4a7eff; color: #fff; }
        .btn.primary:hover { background: linear-gradient(180deg, #5a8bff, #3a6ae8); }
        .btn.danger { background: rgba(255,93,93,.1); border-color: rgba(255,93,93,.3); color: #ff9d9d; }
        .btn.danger:hover { background: rgba(255,93,93,.18); }
        .btn.tiny { padding: 3px 8px; font-size: 11.5px; }
        .rate {
            margin-left: auto;
            background: rgba(255,255,255,.06);
            border: 1px solid rgba(255,255,255,.1);
            border-radius: 8px;
            color: #dfe4ee;
            font: inherit;
            padding: 4px 6px;
            outline: none;
            cursor: pointer;
        }
        .rate:focus { border-color: #4c8dff; }
        .lock { display: flex; align-items: center; gap: 4px; color: #b7c0d2; font-size: 11.5px; cursor: pointer; }
        .lock input { accent-color: #4c8dff; margin: 0; }
        .hint { color: #69738a; font-size: 10.5px; margin-top: -3px; }
        .statusline { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .pill {
            flex: none;
            padding: 2px 9px;
            border-radius: 999px;
            background: rgba(76,141,255,.14);
            color: #a8c4ff;
            font-size: 11.5px;
            font-weight: 600;
        }
        .chapter { color: #98a2b8; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .time { margin-left: auto; color: #8b95aa; font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
        .progress { height: 6px; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; }
        .bar { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #3f7bff, #2ee6a8); transition: width .35s linear; }
        .activity { color: #8d97ac; font-size: 11.5px; min-height: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .toggles { color: #b7c0d2; font-size: 11.5px; }
        .toggles label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .toggles input { accent-color: #4c8dff; margin: 0; }
        .log {
            height: 168px;
            overflow-y: auto;
            background: rgba(0,0,0,.32);
            border: 1px solid rgba(255,255,255,.06);
            border-radius: 10px;
            padding: 7px 8px;
            font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
            font-size: 11px;
            line-height: 1.55;
            user-select: text;
            scrollbar-width: thin;
        }
        .log::-webkit-scrollbar { width: 6px; }
        .log::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
        .line { display: flex; gap: 6px; word-break: break-word; }
        .line .t { color: #5c667a; flex: none; font-variant-numeric: tabular-nums; }
        .line.info .m { color: #b9c3d6; }
        .line.success .m { color: #63e6b0; }
        .line.warn .m { color: #ffcf6b; }
        .line.error .m { color: #ff8f8f; }
        .foot { color: #5f6a7f; font-size: 10px; text-align: right; }
    `;

    const MARKUP = `
        <div class="panel" id="panel">
            <div class="head" id="drag">
                <span class="dot" id="dot"></span>
                <span class="title">${PLATFORM_NAME}学习助手</span>
                <span class="ver">v${VERSION}</span>
                <span class="spacer"></span>
                <button class="icon" data-act="min" title="最小化">–</button>
                <button class="icon" data-act="hide" title="隐藏（Alt+Shift+D 恢复）">×</button>
            </div>
            <div class="body">
                <div class="row keyrow">
                    <input id="key" type="password" spellcheck="false" autocomplete="off" placeholder="粘贴 DeepSeek API Key（sk-…）">
                    <button class="btn" data-act="save-key">保存</button>
                    <button class="btn" data-act="test-key">测试</button>
                </div>
                <div class="hint">视频无需 Key；AI 答题会将题干、选项及图片发送到 DeepSeek。</div>
                <div class="statusline">
                    <span class="pill" id="step">未开始</span>
                    <span class="chapter" id="chapter"></span>
                    <span class="time" id="time">--:--</span>
                </div>
                <div class="progress"><div class="bar" id="bar"></div></div>
                <div class="activity" id="activity">等待页面加载…</div>
                <div class="row">
                    <button class="btn primary" data-act="start">开始</button>
                    <button class="btn danger" data-act="stop">停止</button>
                    <button class="btn" data-act="next">下一节</button>
                    <select class="rate" id="rate" title="播放倍速（默认跟随页面）">
                        <option value="0">跟随页面</option>
                        <option value="1">1.0x</option>
                        <option value="1.25">1.25x</option>
                        <option value="1.5">1.5x</option>
                        <option value="1.75">1.75x</option>
                        <option value="2">2.0x</option>
                        <option value="2.5">2.5x</option>
                        <option value="3">3.0x</option>
                    </select>
                    <label class="lock" title="拦截页面把倍速改回 1x"><input type="checkbox" id="lock-rate"> 锁定</label>
                </div>
                <div class="row toggles">
                    <label><input type="checkbox" id="auto-quiz"> 自动答题</label>
                    <label><input type="checkbox" id="auto-next"> 自动跳节</label>
                    <span class="spacer"></span>
                    <button class="btn tiny" data-act="inspect">识别题目</button>
                    <button class="btn tiny" data-act="diagnose">字体诊断</button>
                    <button class="btn tiny" data-act="clear">清空日志</button>
                </div>
                <div class="log" id="log"></div>
                <div class="foot"><span id="rate-actual">实际 —</span> · deepseek-flash · 低强度思考 · 8000 tokens</div>
            </div>
        </div>
    `;

    let host = null;
    let shadow = null;
    let panelEl = null;
    let ui = {};

    function timeLabel() {
        const now = new Date();
        return [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((value) => String(value).padStart(2, '0')).join(':');
    }

    function log(level, message) {
        const levels = ['info', 'success', 'warn', 'error'];
        const kind = levels.includes(level) ? level : 'info';
        const text = typeof message === 'string' ? message : String(message);
        try {
            if (kind === 'error') console.error('[XT-DS]', text);
            else if (kind === 'warn') console.warn('[XT-DS]', text);
            else console.log('[XT-DS]', text);
        } catch (error) {
            /* 忽略控制台不可用 */
        }
        if (!ui.logEl) return;
        const line = document.createElement('div');
        line.className = 'line ' + kind;
        const time = document.createElement('span');
        time.className = 't';
        time.textContent = timeLabel();
        const body = document.createElement('span');
        body.className = 'm';
        body.textContent = text;
        line.append(time, body);
        const stick = ui.logEl.scrollHeight - ui.logEl.scrollTop - ui.logEl.clientHeight < 48;
        ui.logEl.append(line);
        while (ui.logEl.children.length > LOG_LIMIT) ui.logEl.firstElementChild.remove();
        if (stick) ui.logEl.scrollTop = ui.logEl.scrollHeight;
    }

    function setActivity(text) {
        state.activity = text;
        if (ui.activityEl) ui.activityEl.textContent = text;
    }

    function setMode(mode) {
        state.mode = mode;
        if (ui.dotEl) ui.dotEl.className = 'dot ' + mode;
    }

    function setText(element, text) {
        if (element && element.textContent !== text) element.textContent = text;
    }

    function mount() {
        if (host) return;
        host = document.createElement('div');
        host.id = 'xt-ds-host';
        host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
        shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>${CSS}</style>${MARKUP}`;
        (document.documentElement || document.body).appendChild(host);

        ui = {
            panelEl: shadow.getElementById('panel'),
            dragEl: shadow.getElementById('drag'),
            dotEl: shadow.getElementById('dot'),
            stepEl: shadow.getElementById('step'),
            chapterEl: shadow.getElementById('chapter'),
            timeEl: shadow.getElementById('time'),
            barEl: shadow.getElementById('bar'),
            activityEl: shadow.getElementById('activity'),
            logEl: shadow.getElementById('log'),
            keyEl: shadow.getElementById('key'),
            autoQuizEl: shadow.getElementById('auto-quiz'),
            autoNextEl: shadow.getElementById('auto-next'),
            rateEl: shadow.getElementById('rate'),
            rateActualEl: shadow.getElementById('rate-actual'),
            lockEl: shadow.getElementById('lock-rate'),
        };
        panelEl = ui.panelEl;

        ui.keyEl.value = settings.apiKey;
        ui.autoQuizEl.checked = settings.autoQuiz;
        ui.autoNextEl.checked = settings.autoNext;
        if (IS_ZHIHUI) {
            const limit = document.createElement('option');
            limit.value = '1.8';
            limit.textContent = '1.8x';
            const firstUnsupported = Array.from(ui.rateEl.options).find(option => Number(option.value) > 1.8);
            ui.rateEl.insertBefore(limit, firstUnsupported || null);
            Array.from(ui.rateEl.options).forEach(option => { if (Number(option.value) > 1.8) option.disabled = true; });
            settings.rate = Math.min(1.8, settings.rate);
        }
        ui.rateEl.value = String(settings.rate || 0);
        ui.lockEl.checked = settings.lockRate;
        if (settings.minimized) panelEl.classList.add('min');

        const saved = settings.position;
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            panelEl.style.left = clamp(saved.x, 0, window.innerWidth - 120) + 'px';
            panelEl.style.top = clamp(saved.y, 0, window.innerHeight - 48) + 'px';
        } else {
            panelEl.style.right = '18px';
            panelEl.style.top = '76px';
        }

        shadow.addEventListener('click', onPanelClick);
        ui.keyEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveKey();
            }
            event.stopPropagation();
        });
        ui.keyEl.addEventListener('input', () => {
            const value = String(ui.keyEl.value || '').trim();
            if (value !== settings.apiKey) state.app?.cancelQuizContext?.();
            settings.apiKey = value;
            if (state.app) state.app._inlineKeyWarned = false;
        });
        ui.autoQuizEl.addEventListener('change', () => {
            if (settings.autoQuiz !== ui.autoQuizEl.checked) state.app?.cancelQuizContext?.();
            settings.autoQuiz = ui.autoQuizEl.checked;
            storage.set('autoQuiz', settings.autoQuiz);
            log('info', `自动答题已${settings.autoQuiz ? '开启' : '关闭'}`);
        });
        ui.autoNextEl.addEventListener('change', () => {
            settings.autoNext = ui.autoNextEl.checked;
            storage.set('autoNext', settings.autoNext);
            log('info', `自动跳节已${settings.autoNext ? '开启' : '关闭'}`);
        });
        ui.rateEl.addEventListener('change', () => {
            const rate = IS_ZHIHUI ? Math.min(1.8, Number(ui.rateEl.value) || 0) : Number(ui.rateEl.value) || 0;
            ui.rateEl.value = String(rate);
            settings.rate = rate;
            storage.set('rate', rate);
            rateBlocked = false;
            if (state.app) {
                state.app._rateWarned = false;
                state.app._rateResets = 0;
            }
            if (rate <= 0 || !settings.lockRate) {
                const video = state.app && state.app._videoEl;
                unlockRateLock(video);
            }
            applyRateToCurrent();
            log('info', rate > 0 ? `播放倍速已设为 ${rate}x（含后续视频）` : '播放倍速已恢复为跟随页面');
        });
        ui.lockEl.addEventListener('change', () => {
            settings.lockRate = ui.lockEl.checked;
            storage.set('lockRate', settings.lockRate);
            if (!settings.lockRate) {
                const video = state.app && state.app._videoEl;
                unlockRateLock(video);
            }
            applyRateToCurrent();
            log('info', `倍速锁定已${settings.lockRate ? '开启' : '关闭'}`);
        });

        enableDrag();
        ['keydown', 'keyup', 'keypress'].forEach((type) => {
            host.addEventListener(type, (event) => event.stopPropagation());
        });
        window.addEventListener('resize', clampPosition);
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function clampPosition() {
        if (!panelEl || !panelEl.style.left) return;
        const rect = panelEl.getBoundingClientRect();
        panelEl.style.left = clamp(rect.left, 0, Math.max(0, window.innerWidth - Math.min(rect.width, 372))) + 'px';
        panelEl.style.top = clamp(rect.top, 0, Math.max(0, window.innerHeight - 52)) + 'px';
    }

    function enableDrag() {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        ui.dragEl.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button')) return;
            const rect = panelEl.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            panelEl.style.right = 'auto';
            panelEl.style.left = rect.left + 'px';
            panelEl.style.top = rect.top + 'px';
            ui.dragEl.setPointerCapture(event.pointerId);
        });
        ui.dragEl.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const width = panelEl.getBoundingClientRect().width;
            panelEl.style.left = clamp(event.clientX - offsetX, 0, Math.max(0, window.innerWidth - width)) + 'px';
            panelEl.style.top = clamp(event.clientY - offsetY, 0, Math.max(0, window.innerHeight - 44)) + 'px';
        });
        const end = (event) => {
            if (!dragging) return;
            dragging = false;
            const rect = panelEl.getBoundingClientRect();
            settings.position = { x: rect.left, y: rect.top };
            storage.set('position', settings.position);
        };
        ui.dragEl.addEventListener('pointerup', end);
        ui.dragEl.addEventListener('pointercancel', end);
    }

    function toggleMin() {
        if (!panelEl) return;
        panelEl.classList.toggle('min');
        settings.minimized = panelEl.classList.contains('min');
        storage.set('minimized', settings.minimized);
        clampPosition();
    }

    function toggleVisible() {
        if (!host) return;
        host.style.display = host.style.display === 'none' ? '' : 'none';
    }

    function onPanelClick(event) {
        const button = event.target.closest('[data-act]');
        if (!button) return;
        event.preventDefault();
        const action = button.dataset.act;
        if (action === 'save-key') saveKey();
        else if (action === 'test-key') testKey();
        else if (action === 'start') startAutomation();
        else if (action === 'stop') stopAutomation('手动停止');
        else if (action === 'next') advanceOnce();
        else if (action === 'inspect') inspectQuestions();
        else if (action === 'diagnose') diagnoseFont();
        else if (action === 'clear') {
            if (ui.logEl) ui.logEl.textContent = '';
        } else if (action === 'min') toggleMin();
        else if (action === 'hide') toggleVisible();
    }

    function currentApiKey() {
        const typed = ui && ui.keyEl ? String(ui.keyEl.value || '').trim() : '';
        return typed || clean(settings.apiKey);
    }

    function saveKey() {
        const value = String(ui.keyEl.value || '').trim();
        if (value !== settings.apiKey) state.app?.cancelQuizContext?.();
        settings.apiKey = value;
        storage.set('apiKey', value);
        if (state.app) state.app._inlineKeyWarned = false;
        log(value ? 'success' : 'warn', value ? 'API Key 已保存到本机油猴存储' : '已清空 API Key');
        setActivity(value ? 'API Key 已保存' : '未设置 API Key');
    }

    async function testKey() {
        const key = String(ui.keyEl.value || settings.apiKey || '').trim();
        if (!key) {
            log('warn', '请先填写 API Key');
            return;
        }
        setActivity('正在验证 API Key…');
        try {
            const response = await gmRequest({
                method: 'GET',
                url: MODELS_URL,
                headers: { Authorization: `Bearer ${key}` },
                timeout: 20000,
            });
            if (response.status === 200) {
                log('success', 'API Key 可用');
                setActivity('API Key 验证通过');
            } else {
                const message = describeHttpError(response);
                log('error', message);
                setActivity(message);
            }
        } catch (error) {
            log('error', error.message || String(error));
            setActivity(error.message || '验证失败');
        }
    }

    function applyRateToCurrent() {
        if (!state.app) return;
        let video = null;
        try {
            video = state.app._videoEl || (typeof state.app._getVideoEl === 'function' ? state.app._getVideoEl() : null);
        } catch (error) {
            return;
        }
        if (!video) return;
        if (settings.rate > 0) {
            applyPlaybackRate(video);
            return;
        }
        unlockRateLock(video);
        try {
            video.playbackRate = 1;
        } catch (error) {
            /* 个别播放器禁止修改倍速 */
        }
    }

    function startAutomation() {
        const typedKey = String(ui.keyEl?.value || '').trim();
        if (typedKey !== settings.apiKey) {
            settings.apiKey = typedKey;
            storage.set('apiKey', typedKey);
        }
        if (state.app && typeof state.app.destroy === 'function') {
            try {
                state.app.destroy();
            } catch (error) {
                /* 忽略旧实例清理失败 */
            }
        }
        state.app = null;
        if (!IS_ZHIHUI && (!getJQuery() || !getJQuery().fn)) {
            log('error', '页面尚未加载 jQuery，请稍后重试');
            return;
        }
        setMode('running');
        setActivity('正在启动自动化…');
        try {
            const app = IS_ZHIHUI ? createZhihuishuPlayer() : createPlayer();
            state.app = app;
            app.run();
            if (typeof app._bindPageGuards === 'function') app._bindPageGuards();
        } catch (error) {
            try {
                state.app?.destroy?.();
            } catch (cleanupError) {
                /* 忽略清理失败 */
            }
            state.app = null;
            setMode('error');
            const message = error.message || String(error);
            log('error', `启动失败：${message}`);
            setActivity(`启动失败：${message}`);
        }
    }

    function stopAutomation(reason) {
        if (state.app && typeof state.app.destroy === 'function') {
            try {
                state.app.destroy();
            } catch (error) {
                /* 忽略清理失败 */
            }
        }
        state.app = null;
        setMode('idle');
        setActivity(reason ? `已停止（${reason}）` : '已停止');
        log('warn', '自动化已停止');
    }

    function advanceOnce() {
        if (!state.app) {
            log('warn', '尚未启动，请先点击“开始”');
            return;
        }
        state.app.nextUnit();
        setActivity('已请求切换下一节');
    }

    function inspectQuestions() {
        if (!state.app) {
            log('warn', '尚未启动，请先点击“开始”');
            return;
        }
        let list = [];
        try {
            list = state.app.inspectQuiz() || [];
        } catch (error) {
            log('error', `识别题目失败：${error.message || error}`);
            return;
        }
        if (!list.length) {
            log('warn', '当前页面没有识别到题目（可能尚未进入章节测验）');
            return;
        }
        if (!IS_ZHIHUI) log('info', '注意：学习通可能用字体反爬替换页面文字，以下是页面原文；作答时模型会先还原');
        log('info', `识别到 ${list.length} 道题：`);
        for (const item of list) {
            log('info', `${item.id}. [${item.type}] ${truncate(item.question, 40)}｜选项 ${item.options.length} 个${item.imageCount ? `｜图片 ${item.imageCount} 张（图文识别）` : ''}`);
        }
    }

    function diagnoseFont() {
        const lines = [];
        try {
            performance.getEntriesByType('resource')
                .filter((entry) => /\.(woff2?|ttf|otf)(\?|#|$)/i.test(entry.name))
                .slice(0, 10)
                .forEach((entry) => lines.push(`字体资源：${entry.name}`));
        } catch (error) {
            /* 忽略 */
        }
        try {
            document.fonts.forEach((font) => lines.push(`@font：${font.family} ${font.weight} ${font.status}`));
        } catch (error) {
            /* 忽略 */
        }
        try {
            for (const sheet of Array.from(document.styleSheets)) {
                let rules = null;
                try {
                    rules = sheet.cssRules;
                } catch (error) {
                    continue;
                }
                for (const rule of Array.from(rules || [])) {
                    if (rule.type === 5) lines.push(`@font-face：${rule.style.fontFamily} ${truncate(rule.style.src, 120)}`);
                }
            }
        } catch (error) {
            /* 忽略 */
        }
        let card = null;
        try {
            const questions = extractQuestions();
            card = questions[0]?.card || document.querySelector('.questionLi, .TiMu, .mark_item, .question');
        } catch (error) {
            card = document.querySelector('.questionLi, .TiMu, .mark_item, .question');
        }
        if (card) {
            const style = getComputedStyle(card);
            lines.push(`题目字体：${style.fontFamily} / ${style.fontSize} / 颜色 ${style.color}`);
            for (const pseudo of ['::before', '::after']) {
                try {
                    const content = getComputedStyle(card, pseudo).content;
                    if (content && content !== 'none' && content !== 'normal') lines.push(`${pseudo}：${truncate(content, 100)}`);
                } catch (error) {
                    /* 忽略 */
                }
            }
            for (const attr of ['title', 'aria-label', 'data-title', 'data-text']) {
                const value = card.getAttribute(attr);
                if (value) lines.push(`${attr}：${truncate(value, 80)}`);
            }
        } else {
            lines.push('未找到题目卡片，请在章节测验页运行');
        }
        try {
            let found = 0;
            for (const doc of deepDocuments()) {
                const submit = findButtonContaining(doc, '提交');
                if (submit && visible(submit)) {
                    const container = submit.parentElement?.parentElement;
                    lines.push(`提交按钮：<${submit.tagName}> ${truncate(clean(submit.innerText || submit.value), 20)}｜容器：${truncate(clean(container?.innerText), 80)}`);
                    found++;
                    if (found >= 3) break;
                }
            }
        } catch (error) {
            /* 忽略 */
        }
        log('info', '=== 字体/伪元素诊断 ===');
        lines.slice(0, 30).forEach((line) => log('info', line));
        if (!lines.length) log('warn', '未发现字体或伪元素线索');
    }

    function renderStatus() {
        if (!ui.stepEl) return;
        const app = state.app;
        let step = '';
        if (app) {
            try {
                step = app._currentStepTitle() || '';
            } catch (error) {
                step = '';
            }
        }
        if (!step) {
            step = app ? '待命'
                : state.mode === 'error' ? '异常'
                    : state.mode === 'waiting' ? '等待页面' : '未开始';
        }
        setText(ui.stepEl, step);

        let chapter = '';
        if (app && app._cellData) {
            const data = app._cellData;
            if (data.cells) chapter = IS_ZHIHUI ? `视频 ${data.currentCellIndex + 1}/${data.cells}` : `第 ${data.currentCellIndex + 1}/${data.cells} 章 · 第 ${data.currentNCellIndex + 1} 节`;
            if (data.currentVideoTitle) chapter += ` · ${truncate(data.currentVideoTitle, 16)}`;
        }
        setText(ui.chapterEl, chapter);

        let time = '--:--';
        let percent = 0;
        if (app) {
            try {
                const video = app._videoEl;
                if (video && Number.isFinite(video.duration) && video.duration > 0) {
                    percent = Math.min(100, (video.currentTime / video.duration) * 100);
                    time = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
                }
            } catch (error) {
                /* 忽略读取失败 */
            }
        }
        if (ui.barEl) ui.barEl.style.width = percent.toFixed(2) + '%';
        setText(ui.timeEl, time);

        let actualRate = '实际 —';
        if (app) {
            try {
                const video = app._videoEl;
                if (video) actualRate = `实际 ${Number(video.playbackRate) || 1}x`;
            } catch (error) {
                /* 忽略读取失败 */
            }
        }
        setText(ui.rateActualEl, actualRate);
    }

    function installHotkey() {
        window.addEventListener('keydown', (event) => {
            if (event.altKey && event.shiftKey && String(event.key).toLowerCase() === 'd') {
                event.preventDefault();
                event.stopPropagation();
                toggleVisible();
            }
        }, true);
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        try {
            GM_registerMenuCommand('显示 / 隐藏面板', toggleVisible);
            GM_registerMenuCommand('开始自动化', () => startAutomation());
            GM_registerMenuCommand('停止自动化', () => stopAutomation('菜单停止'));
            GM_registerMenuCommand('识别当前题目', inspectQuestions);
            GM_registerMenuCommand('字体 / 伪元素诊断', diagnoseFont);
            GM_registerMenuCommand('清空日志', () => {
                if (ui.logEl) ui.logEl.textContent = '';
            });
        } catch (error) {
            /* 菜单不可用时忽略 */
        }
    }

    function ensureJQuery() {
        return new Promise((resolve, reject) => {
            let injected = false;
            const started = Date.now();
            const timer = setInterval(() => {
                if (getJQuery() && getJQuery().fn) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
                const elapsed = Date.now() - started;
                if (!injected && elapsed >= 2500) {
                    injected = true;
                    try {
                        const script = document.createElement('script');
                        script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
                        script.onerror = () => log('warn', 'jQuery 备用地址加载失败，继续等待页面自身脚本');
                        (document.head || document.documentElement).appendChild(script);
                    } catch (error) {
                        log('warn', '注入 jQuery 失败，继续等待页面自身脚本');
                    }
                }
                if (elapsed >= 20000) {
                    clearInterval(timer);
                    reject(new Error('页面未加载 jQuery，无法启动自动化'));
                }
            }, 200);
        });
    }

    async function waitForCourseTree() {
        for (let attempt = 0; attempt < 240; attempt++) {
            if (getJQuery() && getJQuery()('#coursetree').length > 0) return true;
            if (attempt % 20 === 0) setActivity('等待课程页面加载（#coursetree）…');
            await sleep(250);
        }
        return false;
    }

    function relaxNativeConfirm() {
        try {
            const target = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
            target.confirm = () => true;
            if (typeof target.eval === 'function') target.eval('window.confirm = function () { return true; };');
        } catch (error) {
            /* 页面禁止改写时忽略 */
        }
    }

    async function boot() {
        if (IS_ZHIHUI) {
            startAutomation();
            return;
        }
        setMode('waiting');
        setActivity('正在等待学习通课程页…');
        try {
            await ensureJQuery();
            const ready = await waitForCourseTree();
            if (!ready) {
                setMode('idle');
                log('warn', '60 秒内未检测到课程目录，请确认已进入课程播放页；可稍后点击“开始”');
                setActivity('未检测到课程目录，可手动开始');
                return;
            }
            if (!settings.apiKey) {
                log('warn', '尚未保存 API Key：视频可自动播放，章节测验前需要填写');
            }
            startAutomation();
        } catch (error) {
            setMode('error');
            const message = error.message || String(error);
            log('error', message);
            setActivity(message);
        }
    }

    /* ------------------------------------------------------------------ 启动 */

    mount();
    registerMenus();
    installHotkey();
    if (!IS_ZHIHUI) relaxNativeConfirm();
    log('info', `面板已加载 v${VERSION}`);
    if (settings.apiKey) log('info', '已读取本机保存的 API Key');
    setInterval(renderStatus, 1000);
    boot();

    // 便于在油猴管理面板外调试：window.__xtDs
    try {
        window.__xtDs = {
            version: VERSION,
            get app() { return state.app; },
            start: startAutomation,
            stop: stopAutomation,
            inspect: inspectQuestions,
            requestAnswers,
        };
    } catch (error) {
        /* 某些页面禁用 window 扩展时忽略 */
    }
})();
