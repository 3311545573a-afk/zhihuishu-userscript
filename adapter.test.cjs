const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'xuexitong-zhihuishu.user.js'), 'utf8');
const course = `<div id="vjs_container"><video id="vjs_container_html5_api" src="one.mp4"></video></div>
<ul class="list"><li class="chapter">第一章</li>
<li class="video current_play"><span class="catalogue_title" title="当前视频">当前视频</span></li>
<li class="chapter-test">章节测试</li>
<li class="video"><span class="catalogue_title">已完成</span><b class="time_icofinish"></b></li>
<li class="video"><span class="catalogue_title">下一视频</span></li></ul>`;

function browser(html = course, options = {}) {
    const dom = new JSDOM(html, {
        url: options.url || 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=test',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const w = dom.window;
    const intervals = new Map();
    let clock = 100000;
    let intervalId = 0;
    w.Date.now = () => clock;
    w.setInterval = (fn) => { intervals.set(++intervalId, fn); return intervalId; };
    w.clearInterval = (id) => intervals.delete(id);
    w.HTMLElement.prototype.getClientRects = function () {
        for (let node = this; node; node = node.parentElement) {
            if (node.hidden || w.getComputedStyle(node).display === 'none') return [];
        }
        return [{ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 }];
    };
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.GM_getValue = (key, fallback) => Object.hasOwn(options.settings || {}, key) ? options.settings[key] : fallback;
    w.GM_setValue = () => {};
    w.GM_registerMenuCommand = () => {};
    const requests = [];
    w.GM_xmlhttpRequest = details => {
        requests.push(details);
        if (options.deferAI) return;
        details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(options.aiResponse || { answers: [{ id: 1, letters: ['B'], restored: '一加一等于多少？' }] }) } }] }) });
    };
    const confirm = w.confirm = () => false;
    const media = { playCalls: 0, pauseCalls: 0, paused: true, ended: false, duration: 60, time: 10 };
    const video = w.document.querySelector('video');
    if (video) {
        Object.defineProperties(video, {
            paused: { get: () => media.paused }, ended: { get: () => media.ended },
            duration: { get: () => media.duration }, readyState: { get: () => 4 },
            currentTime: { get: () => media.time, set: v => { media.time = v; } },
        });
        video.play = async () => {
            media.playCalls++;
            if (options.blockAutoplay) throw new w.DOMException('user gesture required', 'NotAllowedError');
            media.paused = false;
            video.dispatchEvent(new w.Event('play'));
        };
        video.pause = () => {
            media.pauseCalls++;
            const wasPlaying = !media.paused;
            media.paused = true;
            // 原生 pause() 同步改 paused，再通过媒体任务异步派发 pause 事件。
            if (wasPlaying && options.queuedPauseEvents) w.setTimeout(() => video.dispatchEvent(new w.Event('pause')), 0);
        };
    }
    const fixture = options.setup?.(w) || {};
    w.eval(source);
    const control = w.__xtDs;
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    return {
        w, dom, media, video, control, confirm, intervals, flush, requests, fixture,
        async mediaTask() { await new Promise(resolve => w.setTimeout(resolve, 0)); await flush(); },
        async tick(ms = 1000) {
            clock += ms;
            for (const fn of [...intervals.values()]) fn();
            await flush();
        },
        close() { control?.stop('测试结束'); dom.window.close(); },
    };
}

test('元数据覆盖实际智慧树共享课路由，同时保留学习通', () => {
    assert.ok(/@match\s+https:\/\/studyvideoh5\.zhihuishu\.com\/stuStudy\*/.test(source), '应声明实际共享课路由');
    assert.match(source, /@match\s+\*:\/\/\*\.chaoxing\.com\/mycourse\/studentstudy\*/);
});

test('智慧树无 jQuery 也能启动并识别顶层视频，不改写原生 confirm', async () => {
    const b = browser();
    try {
        await b.flush();
        assert.ok(b.control.app, '智慧树适配器应成功创建');
        assert.equal(b.control.app._videoEl, b.video);
        assert.equal(b.media.playCalls, 1);
        assert.equal(b.w.confirm, b.confirm);
        assert.match(b.w.document.querySelector('#xt-ds-host').shadowRoot.textContent, /智慧树/);
    } finally { b.close(); }
});

test('没有已验证课程组件时自然结束也不盲点目录', async () => {
    const b = browser();
    try {
        await b.flush();
        const clicked = [];
        b.w.document.querySelectorAll('li').forEach(el => el.addEventListener('click', () => {
            clicked.push(el.textContent.trim());
            b.w.document.querySelector('.current_play')?.classList.remove('current_play');
            el.classList.add('current_play');
            b.media.ended = false;
            b.media.time = 0;
        }));
        b.media.ended = true; b.media.time = 60;
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(1000);
        await b.tick(3000);
        assert.deepEqual(clicked, []);
        await b.tick(3000);
        assert.deepEqual(clicked, [], '不能重复点击');
    } finally { b.close(); }
});

test('暂停或接近结尾不等于学习完成', async () => {
    const b = browser();
    try {
        await b.flush();
        assert.ok(b.control.app);
        let clicks = 0;
        b.w.document.querySelectorAll('li').forEach(el => el.addEventListener('click', () => clicks++));
        b.media.time = 59.9; b.media.paused = true;
        await b.tick(10000);
        assert.equal(clicks, 0);
    } finally { b.close(); }
});

test('可见验证码阻止播放和跳节，隐藏模板不会误报', async () => {
    const b = browser(course + '<iframe id="tcaptcha_iframe_dy" style="display:none"></iframe>');
    try {
        await b.flush();
        assert.equal(b.media.playCalls, 1);
        const captcha = b.w.document.getElementById('tcaptcha_iframe_dy');
        captcha.style.display = 'block';
        await b.tick();
        assert.equal(b.media.paused, true);
        let clicks = 0;
        b.w.document.querySelectorAll('li').forEach(el => el.addEventListener('click', () => clicks++));
        b.control.app.nextUnit();
        await b.flush();
        assert.equal(clicks, 0);
        captcha.style.display = 'none';
        await b.tick();
        assert.equal(b.media.playCalls, 2);
    } finally { b.close(); }
});

function captchaRect(element, { x = 0, y = 0, width = 300, height = 150 } = {}) {
    element.getClientRects = () => [{ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }];
}

test('实际页面全透明且移到屏幕外的腾讯验证码常驻节点不会误报', async () => {
    const b = browser(course + '<div id="tcaptcha_transform_dy" style="opacity:0;position:absolute;top:-1000000px"><iframe id="tcaptcha_iframe_dy" src="https://turing.captcha.gtimg.com/1/template/drag_ele.html"></iframe></div>', {
        setup(w) {
            for (const el of w.document.querySelectorAll('[id^="tcaptcha_"]')) captchaRect(el, { y: -1000000 });
        },
    });
    try {
        await b.flush();
        assert.equal(b.control.app._blockedReason, '', '常驻隐藏 iframe 不是等待人工验证');
        assert.equal(b.media.playCalls, 1);
    } finally { b.close(); }
});

test('空的腾讯验证码 SDK 容器不会误报', async () => {
    const b = browser(course + '<div id="tcaptcha_transform_dy"></div>');
    try {
        await b.flush();
        assert.equal(b.control.app._blockedReason, '');
        assert.equal(b.media.playCalls, 1);
    } finally { b.close(); }
});

for (const [name, html, rect] of [
    ['自身透明', '<iframe id="tcaptcha_iframe_dy" style="opacity:0"></iframe>', {}],
    ['祖先透明', '<div style="opacity:0"><iframe id="tcaptcha_iframe_dy"></iframe></div>', {}],
    ['屏幕上方', '<iframe id="tcaptcha_iframe_dy"></iframe>', { y: -1000000 }],
    ['屏幕右侧', '<iframe id="tcaptcha_iframe_dy"></iframe>', { x: 1000000 }],
    ['零宽度', '<iframe id="tcaptcha_iframe_dy"></iframe>', { width: 0 }],
    ['零高度', '<iframe id="tcaptcha_iframe_dy"></iframe>', { height: 0 }],
]) {
    test(`不可见验证码（${name}）不会阻止播放`, async () => {
        const b = browser(course + html, {
            setup(w) { captchaRect(w.document.querySelector('#tcaptcha_iframe_dy'), rect); },
        });
        try {
            await b.flush();
            assert.equal(b.control.app._blockedReason, '');
            assert.equal(b.media.playCalls, 1);
        } finally { b.close(); }
    });
}

test('腾讯验证码常驻 iframe 真正显示才暂停，关闭后即使节点保留也恢复', async () => {
    const b = browser(course + '<div id="tcaptcha_transform_dy" style="opacity:0"><iframe id="tcaptcha_iframe_dy" src="https://turing.captcha.gtimg.com/1/template/drag_ele.html"></iframe></div>');
    try {
        await b.flush();
        assert.equal(b.media.playCalls, 1);
        const wrapper = b.w.document.querySelector('#tcaptcha_transform_dy');
        const frame = b.w.document.querySelector('#tcaptcha_iframe_dy');
        wrapper.style.opacity = '1';
        // 部分进入视口也要阻止播放，不能只检测完全露出的验证码。
        captchaRect(frame, { x: -100, y: -50 });
        await b.tick();
        assert.match(b.control.app._blockedReason, /人工验证/);
        assert.equal(b.media.paused, true);
        assert.equal(b.media.playCalls, 1);
        wrapper.style.opacity = '0';
        captchaRect(frame, { y: -1000000 });
        await b.tick();
        assert.equal(b.control.app._blockedReason, '');
        assert.equal(b.media.playCalls, 2);
        assert.ok(frame.isConnected, 'SDK 不移除 iframe 也应解除等待');
    } finally { b.close(); }
});

test('关闭自动跳节后即使自然结束也不点击目录', async () => {
    const b = browser(course, { settings: { autoNext: false } });
    try {
        await b.flush();
        assert.ok(b.control.app);
        let clicks = 0;
        b.w.document.querySelectorAll('li').forEach(el => el.addEventListener('click', () => clicks++));
        b.media.ended = true;
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(5000);
        assert.equal(clicks, 0);
    } finally { b.close(); }
});

test('停止后清理适配器定时任务和视频事件', async () => {
    const b = browser();
    try {
        await b.flush();
        const app = b.control.app;
        assert.ok(app, '需要实际启动智慧树适配器');
        b.control.stop('手动停止');
        const plays = b.media.playCalls;
        b.media.paused = true; b.media.ended = true;
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(5000);
        assert.equal(b.media.playCalls, plays);
        assert.equal(b.control.app, null);
        assert.equal(app._destroyed, true);
    } finally { b.close(); }
});

test('空课程页面保持等待，出现视频后自动发现', async () => {
    const b = browser('<main>课程正在加载</main>');
    try {
        await b.flush();
        assert.ok(b.control.app);
        assert.equal(b.control.app._videoEl, null);
        b.w.document.body.insertAdjacentHTML('afterbegin', course);
        const video = b.w.document.querySelector('video');
        video.play = async () => {};
        await b.tick();
        assert.equal(b.control.app._videoEl, video);
    } finally { b.close(); }
});

test('智慧树考试页分流到作业/考试自动化，不使用共享课播放器', async () => {
    const b = browser(course, { url: 'https://studyvideoh5.zhihuishu.com/exam' });
    try {
        await b.flush();
        assert.ok(b.control.app, '考试页应由作业/考试适配器接管');
        assert.equal(b.control.app._stepTitle, '作业/考试');
        assert.equal(b.control.app._videoEl, undefined, '不能把考试页交给视频适配器');
    } finally { b.close(); }
});

test('浏览器拒绝自动播放时只请求一次，等待用户播放', async () => {
    const b = browser(course, { blockAutoplay: true });
    try {
        await b.flush();
        assert.ok(b.control.app);
        assert.equal(b.media.playCalls, 1);
        await b.tick(10000); await b.tick(10000);
        assert.equal(b.media.playCalls, 1);
    } finally { b.close(); }
});

test('尊重手动暂停，验证码关闭后不恢复原本已暂停的视频', async () => {
    const b = browser(course + '<iframe id="tcaptcha_iframe_dy" style="display:none"></iframe>');
    try {
        await b.flush();
        assert.ok(b.control.app);
        b.media.paused = true;
        b.video.dispatchEvent(new b.w.Event('pause'));
        await b.tick(10000);
        assert.equal(b.media.playCalls, 1);
        const frame = b.w.document.getElementById('tcaptcha_iframe_dy');
        frame.style.display = 'block'; await b.tick();
        frame.style.display = 'none'; await b.tick();
        assert.equal(b.media.playCalls, 1);
    } finally { b.close(); }
});

test('没有课程组件时重复 ended 或超时也不点击视频', async () => {
    const b = browser();
    try {
        await b.flush();
        assert.ok(b.control.app);
        let clicks = 0;
        b.w.document.querySelectorAll('li').forEach(el => el.addEventListener('click', () => clicks++));
        b.media.ended = true;
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(3000); await b.tick(3000); await b.tick(20000);
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(20000);
        assert.equal(clicks, 0);
    } finally { b.close(); }
});

test('下一视频锁定或当前项不明确时不猜测点击', async () => {
    for (const html of [course.replace('下一视频</span></li>', '下一视频</span></li>').replace('<li class="video"><span class="catalogue_title">下一视频', '<li class="video locked"><span class="catalogue_title">下一视频'), course.replace('video current_play', 'video')]) {
        const b = browser(html);
        try {
            await b.flush();
            assert.ok(b.control.app);
            let clicks = 0;
            b.w.document.querySelectorAll('li').forEach(el => el.addEventListener('click', () => clicks++));
            b.control.app.nextUnit(); await b.flush();
            assert.equal(clicks, 0);
        } finally { b.close(); }
    }
});

test('未知可见弹窗暂停播放且不擅自点击确认', async () => {
    const b = browser(course + '<div role="dialog" style="display:none"><button>确认</button><p>请人工确认</p></div>');
    try {
        await b.flush();
        assert.ok(b.control.app);
        let clicks = 0;
        b.w.document.querySelector('[role="dialog"] button').onclick = () => clicks++;
        b.w.document.querySelector('[role="dialog"]').style.display = 'block';
        await b.tick(5000);
        assert.equal(b.media.paused, true);
        assert.equal(clicks, 0);
    } finally { b.close(); }
});

const topic = `<div id="playTopic-dialog" class="dialog-test">
<div class="topic-title"><span class="title-tit">单选题</span><span>一加一等于多少？</span></div>
<ul class="topic-list"><li class="topic-item"><span class="topic-option-item">A</span><span class="item-topic">一</span></li>
<li class="topic-item"><span class="topic-option-item">B</span><span class="item-topic">二</span></li></ul>
<div class="dialog-footer"><div class="btn">关闭</div></div></div>`;

test('从实际智慧树弹题类名识别题干、类型与选项', async () => {
    const b = browser(course + topic);
    try {
        await b.flush();
        const list = b.control.app.inspectQuiz();
        assert.equal(list.length, 1);
        assert.equal(list[0].type, '单选题');
        assert.equal(list[0].question, '一加一等于多少？');
        assert.deepEqual(Array.from(list[0].options), ['A. 一', 'B. 二']);
        assert.equal(b.media.playCalls, 0, '弹题显示时不能自动播放');
    } finally { b.close(); }
});

test('找不到已验证弹题组件时只发送一次请求并显示AI建议', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' } });
    try {
        let clicks = 0;
        b.w.document.querySelector('#playTopic-dialog').addEventListener('click', () => clicks++);
        await b.flush(); await b.tick(); await b.tick();
        assert.equal(b.requests.length, 1);
        assert.equal(clicks, 0);
        assert.match(b.w.document.querySelector('#xt-ds-host').shadowRoot.textContent, /AI 建议.*B/);
        const payload = JSON.parse(b.requests[0].data);
        assert.equal(JSON.parse(payload.messages[1].content)[0].question, '一加一等于多少？');
    } finally { b.close(); }
});

test('关闭 AI 选项或没有 Key 时弹题仍保持人工处理，不请求网络', async () => {
    for (const settings of [{ apiKey: 'sk-test', autoQuiz: false }, {}]) {
        const b = browser(course + topic, { settings });
        try {
            await b.flush(); await b.tick();
            assert.equal(b.requests.length, 0);
            assert.equal(b.media.playCalls, 0);
        } finally { b.close(); }
    }
});

test('隐藏弹题模板不阻止视频，也不被当作题目发送', async () => {
    const b = browser(course + topic.replace('class="dialog-test"', 'class="dialog-test" style="display:none"'), { settings: { apiKey: 'sk-test' } });
    try {
        await b.flush(); await b.tick();
        assert.equal(b.control.app.inspectQuiz().length, 0);
        assert.equal(b.requests.length, 0);
        assert.equal(b.media.playCalls, 1);
    } finally { b.close(); }
});

test('停止后到达的 AI 响应不会显示过期建议或操作页面', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, deferAI: true });
    try {
        await b.flush();
        assert.equal(b.requests.length, 1);
        b.control.stop('手动停止');
        b.requests[0].onload({ status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"answers":[{"id":1,"letters":["B"]}]}' } }] }) });
        await b.flush();
        assert.doesNotMatch(b.w.document.querySelector('#xt-ds-host').shadowRoot.textContent, /AI 建议/);
        assert.equal(b.media.playCalls, 0);
    } finally { b.close(); }
});

// 模拟真实 Vue 2 数据和页面方法；DOM click 故意无效果，以覆盖 isTrusted 限制。
function courseComponent(w, options = {}) {
    const current = { id: 11, videoId: 101, name: '当前视频', ishaveChildrenLesson: 0 };
    const complete = { id: 12, videoId: 102, name: '已完成', ishaveChildrenLesson: 0 };
    const next = { id: 21, videoId: 201, name: '下一视频', ishaveChildrenLesson: 0 };
    const chapters = [
        { name: '第一章', videoLessons: [current, complete] },
        { name: '第二章', videoLessons: [next] },
    ];
    const calls = [];
    const vm = {
        videoList: chapters, lastViewVideoId: current.videoId,
        $children: [], $nextTick: fn => w.queueMicrotask(fn),
        videoClick(...args) {
            calls.push(args);
            if (options.pending) return;
            const target = args[4] || args[2];
            vm.lastViewVideoId = target.videoId;
            w.document.querySelector('.current_play')?.classList.remove('current_play');
            Array.from(w.document.querySelectorAll('li.video')).find(el => el.textContent.trim() === target.name)?.classList.add('current_play');
        },
    };
    const app = w.document.createElement('div');
    app.id = 'app';
    app.__vue__ = { $children: [{ $children: [vm] }] };
    w.document.body.prepend(app);
    // 页面目录常从子组件向父组件找到课程实例。
    w.document.querySelector('.chapterScrollbar').__vue__ = { $parent: vm, $children: [] };
    options.mutate?.(vm);
    return { vm, calls, chapters, current, complete, next };
}

const crossChapterCourse = course
    .replace('<ul class="list">', '<div class="chapterScrollbar"><ul class="list">')
    .replace('<li class="video"><span class="catalogue_title">下一视频', '</ul><ul class="list"><li class="chapter">第二章</li><li class="video"><span class="catalogue_title">下一视频')
    .replace(/<\/ul>$/, '</ul></div>');

test('跨章按真实 videoClick 参数切到未完成视频且不触发DOM事件', async () => {
    const b = browser(crossChapterCourse, { setup: courseComponent });
    try {
        await b.flush();
        let clicks = 0;
        b.w.document.querySelector('.chapterScrollbar').addEventListener('click', () => clicks++);
        b.media.ended = true;
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(3000);
        assert.equal(b.fixture.calls.length, 1);
        const args = b.fixture.calls[0];
        assert.equal(args[0], b.fixture.chapters[1]);
        assert.equal(args[1], 1);
        assert.equal(args[2], b.fixture.next);
        assert.equal(args[3], 0);
        assert.equal(args[4], undefined);
        assert.equal(clicks, 0);
    } finally { b.close(); }
});

test('子小节按父课和子课索引调用真实 videoClick', async () => {
    const b = browser(crossChapterCourse, { setup: w => courseComponent(w, { mutate(vm) {
        vm.videoList[1].videoLessons = [{ id: 20, name: '父课', ishaveChildrenLesson: 1, videoSmallLessons: [{ id: 21, videoId: 201, name: '下一视频' }] }];
    } }) });
    try {
        await b.flush(); b.control.app.nextUnit(); await b.flush();
        const args = b.fixture.calls[0];
        assert.ok(args, '应调用组件方法');
        assert.equal(args[0], b.fixture.chapters[1]);
        assert.equal(args[1], 1);
        assert.equal(args[2], b.fixture.chapters[1].videoLessons[0]);
        assert.equal(args[3], 0);
        assert.equal(args[4], b.fixture.chapters[1].videoLessons[0].videoSmallLessons[0]);
        assert.equal(args[5], 0);
    } finally { b.close(); }
});

test('目录标题、次序或当前videoId不匹配时不操作组件或DOM', async () => {
    for (const mutate of [
        vm => { vm.videoList[1].videoLessons[0].name = '别的视频'; },
        vm => { vm.lastViewVideoId = 999; },
        vm => { vm.videoList[0].videoLessons.reverse(); },
        vm => { vm.videoList[1].videoLessons.push({ id: 22, videoId: 201, name: '下一视频', ishaveChildrenLesson: 0 }); },
    ]) {
        const b = browser(crossChapterCourse, { setup: w => courseComponent(w, { mutate }) });
        try {
            await b.flush(); let clicks = 0;
            b.w.document.querySelector('.chapterScrollbar').onclick = () => clicks++;
            b.control.app.nextUnit(); await b.flush();
            assert.equal(b.fixture.calls.length, 0);
            assert.equal(clicks, 0);
        } finally { b.close(); }
    }
});

test('组件尚未确认切换时重复ended和超时不重复videoClick', async () => {
    const b = browser(crossChapterCourse, { setup: w => courseComponent(w, { pending: true }) });
    try {
        await b.flush(); b.media.ended = true;
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(3000); await b.tick(20000);
        b.video.dispatchEvent(new b.w.Event('ended'));
        await b.tick(20000);
        assert.equal(b.fixture.calls.length, 1);
    } finally { b.close(); }
});

function quizRow(type = '单选题', id = 301, title = '一加一等于多少？') {
    return { isCheck: false, answerStu: '', testQuestion: {
        questionId: id, name: title,
        questionType: { name: type, inputType: type === '多选题' ? 'checkbox' : 'radio' },
        questionOptions: (type === '判断题' ? ['正确', '错误'] : ['一', '二', '三']).map((content, i) => ({ id: id * 10 + i, sortUs: 'ABC'[i], content, isClick: false })),
    } };
}

function quizComponent(rows) {
    return w => {
        const calls = [], pages = [], closes = [];
        const root = w.document.querySelector('#playTopic-dialog');
        const render = () => {
            const row = vm.pageList, question = row.testQuestion;
            root.querySelector('.topic-title').innerHTML = `<span class="title-tit">${question.questionType.name}</span><span>${question.name}</span>`;
            root.querySelector('.topic-list').innerHTML = question.questionOptions.map(option => `<li class="topic-item"><span class="topic-option-item${option.isClick ? ' active' : ''}">${option.sortUs}</span><span class="item-topic${option.isClick ? ' active' : ''}">${option.content}</span></li>`).join('');
        };
        const vm = {
            testDialog: true, topicInfo: { lessonTestQuestionUseInterfaceDtos: rows }, pageList: rows[0],
            $children: [], $nextTick: fn => w.queueMicrotask(fn),
            topicClickQot(option, branch) {
                assert.equal(branch, 2, '必须走页面普通方法分支');
                assert.ok(vm.pageList.testQuestion.questionOptions.includes(option), '使用页面原始option对象');
                calls.push({ option, branch, questionId: vm.pageList.testQuestion.questionId });
                if (vm.pageList.testQuestion.questionType.inputType === 'radio') vm.pageList.testQuestion.questionOptions.forEach(item => { item.isClick = false; });
                option.isClick = !option.isClick;
                vm.pageList.answerStu = vm.pageList.testQuestion.questionOptions.filter(item => item.isClick).map(item => item.id).join(',');
                vm.pageList.isCheck = Boolean(vm.pageList.answerStu);
                render();
            },
            pageeClick(number) { pages.push(number); assert.ok(rows[number - 1], '页面页码从1开始'); vm.pageList = rows[number - 1]; render(); },
            closeTest(done) {
                assert.ok(rows.every(row => row.isCheck), '不能在还有题目未作答时关闭');
                assert.equal(typeof done, 'function', 'closeTest 接受普通回调，不能伪造可信事件');
                closes.push(true); vm.testDialog = false; root.style.display = 'none'; done();
            },
        };
        root.__vue__ = { $parent: vm, $children: [] };
        render();
        return { vm, rows, calls, pages, closes, root, render };
    };
}

// 模拟共享课图片结构：题干与 A-D 都没有 alt/title，使用虚构图片路径。
const formulaImageBase = 'http://image.zhihuishu.com/download/upload/uccmanage/eweb/user/';
function formulaRow(id = 901) {
    const row = quizRow('单选题', id, `<div><img src="${formulaImageBase}fixture-question.png" border="0"></div>`);
    row.testQuestion.questionOptions = ['fixture-option-a.png', 'fixture-option-b.png', 'fixture-option-c.png', 'fixture-option-d.png']
        .map((name, i) => ({ id: id * 10 + i, sortUs: 'ABCD'[i] + '.', content: `<img src="${formulaImageBase}${name}" border="0">`, isClick: false }));
    return row;
}

function aiReply(request, letter = 'B') {
    request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ id: 1, letters: [letter], restored: '根据公式计算' }] }) } }] }) });
}

test('实际高数纯图片题干和四个选项通过图文请求自动选择并关闭', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([formulaRow()]) });
    try {
        await b.flush(); await b.tick();
        assert.equal(b.requests.length, 1, '图片题不能再因文本为空被跳过');
        const payload = JSON.parse(b.requests[0].data);
        assert.ok(Array.isArray(payload.messages[1].content), '必须是图片输入，不能把URL仅拼在文字中');
        const pictures = payload.messages[1].content.filter(part => part.type === 'image_url');
        assert.equal(pictures.length, 5, '题干和四个选项均不能漏图');
        assert.ok(pictures.every(part => part.image_url.url.startsWith('https://image.zhihuishu.com/')));
        assert.equal(b.fixture.calls.length, 1);
        assert.equal(b.fixture.calls[0].option.sortUs, 'B.');
        assert.equal(b.fixture.closes.length, 1);
    } finally { b.close(); }
});

test('识别结果保留文字与多张公式图的顺序、替代文字和上下标', async () => {
    const row = formulaRow();
    row.testQuestion.name = '<p>设 x<sup>2</sup> + a<sub>n</sub>，见<img src="/formula-a.png" alt="积分式">再比较<img src="/formula-b.png">的结果</p>';
    const b = browser(course + topic, { setup: quizComponent([row]) });
    try {
        await b.flush();
        const q = b.control.app.inspectQuiz()[0];
        assert.match(q.question, /x\^\(2\).*a_\(n\).*\[图片1：积分式\].*再比较.*\[图片2\].*的结果/);
        assert.equal(q.imageCount, 6);
        assert.deepEqual(Array.from(q.options), ['A. [图片1]', 'B. [图片1]', 'C. [图片1]', 'D. [图片1]']);
    } finally { b.close(); }
});

test('选项图片与课程组件不一致时只给建议，不自动选择或关闭', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup(w) {
        const fixture = quizComponent([formulaRow()])(w);
        w.document.querySelector('.item-topic img').src = 'https://image.zhihuishu.com/different.png';
        return fixture;
    } });
    try {
        await b.flush(); await b.tick();
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
        assert.match(b.w.document.querySelector('#xt-ds-host').shadowRoot.textContent, /AI 建议/);
    } finally { b.close(); }
});

for (const target of ['题干', '选项']) {
    test(`AI等待期间${target}图片改变使旧答案失效，新图片允许新请求`, async () => {
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([formulaRow()]), deferAI: true });
        try {
            await b.flush();
            assert.equal(b.requests.length, 1);
            if (target === '题干') b.fixture.rows[0].testQuestion.name = '<img src="https://image.zhihuishu.com/new-question.png">';
            else b.fixture.rows[0].testQuestion.questionOptions[0].content = '<img src="https://image.zhihuishu.com/new-option.png">';
            b.fixture.render();
            aiReply(b.requests[0]); await b.flush();
            assert.equal(b.fixture.calls.length, 0, '旧答案不能用于新图');
            await b.tick();
            assert.equal(b.requests.length, 2, '不能把纯图片占位符相同误判为同一题');
            aiReply(b.requests[1]); await b.flush(); await b.tick();
            assert.equal(b.fixture.calls.length, 1);
            assert.equal(b.fixture.closes.length, 1);
        } finally { b.close(); }
    });
}

test('分页图片题不会复用图片不同但占位文字相同的答案缓存', async () => {
    const first = formulaRow(901), second = formulaRow(902);
    second.testQuestion.name = '<img src="https://image.zhihuishu.com/second-question.png">';
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([first, second]) });
    try {
        await b.flush(); await b.tick(); await b.tick();
        assert.equal(b.requests.length, 2);
        assert.deepEqual(b.fixture.calls.map(call => call.questionId), [901, 902]);
        assert.equal(b.fixture.pages.length, 1);
        assert.equal(b.fixture.closes.length, 1);
    } finally { b.close(); }
});

for (const src of ['', 'javascript:alert(1)']) {
    test(`图片源无效（${src || '缺失'}）时不发送残缺题目或自动作答`, async () => {
        const row = formulaRow();
        row.testQuestion.questionOptions[0].content = `<img src="${src}">`;
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([row]) });
        try {
            await b.flush(); await b.tick();
            assert.equal(b.requests.length, 0);
            assert.equal(b.fixture.calls.length, 0);
            assert.equal(b.fixture.closes.length, 0);
            assert.match(b.w.document.querySelector('#xt-ds-host').shadowRoot.textContent, /图片/);
        } finally { b.close(); }
    });
}

test('停止使图片题延迟结果失效，不选择或关闭', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([formulaRow()]), deferAI: true });
    try {
        await b.flush(); assert.equal(b.requests.length, 1);
        b.control.stop('手动停止');
        aiReply(b.requests[0]); await b.flush();
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
    } finally { b.close(); }
});

test('图片被模型拒绝读取时保持弹题，不回退成缺图文本猜答案', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([formulaRow()]), deferAI: true });
    try {
        await b.flush(); assert.equal(b.requests.length, 1);
        b.requests[0].onload({ status: 400, responseText: '{"error":{"message":"image download failed"}}' });
        await b.flush(); await b.tick(10000);
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
        assert.match(b.w.document.querySelector('#xt-ds-host').shadowRoot.textContent, /400/);
    } finally { b.close(); }
});

function respond(request, letters = ['B']) {
    request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ id: 1, letters }] }) } }] }) });
}

for (const [type, letters] of [['单选题', ['B']], ['多选题', ['A', 'C']], ['判断题', ['A']]]) {
    test(`真实${type}通过Vue方法作答并关闭，不触发DOM点击`, async () => {
        const row = quizRow(type);
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([row]), aiResponse: { answers: [{ id: 1, letters }] } });
        try {
            let clicks = 0; b.fixture.root.addEventListener('click', () => clicks++);
            await b.flush(); await b.tick(); await b.tick();
            assert.equal(b.requests.length, 1);
            assert.deepEqual(b.fixture.calls.map(call => call.option.sortUs), letters);
            assert.equal(row.isCheck, true);
            assert.equal(b.fixture.closes.length, 1);
            assert.equal(clicks, 0);
            assert.equal(b.media.playCalls, 1, '网页已关闭弹题后才恢复播放');
        } finally { b.close(); }
    });
}

test('分页弹题逐题完成后只关闭一次', async () => {
    const rows = [quizRow(), quizRow('判断题', 302, '二大于一吗？')];
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent(rows) });
    try {
        await b.flush(); for (let i = 0; i < 5; i++) await b.tick();
        assert.equal(b.requests.length, 2);
        assert.equal(b.fixture.calls.length, 2);
        assert.deepEqual(b.fixture.calls.map(call => call.questionId), [301, 302]);
        assert.ok(rows.every(row => row.isCheck));
        assert.ok(b.fixture.pages.includes(2));
        assert.equal(b.fixture.closes.length, 1);
    } finally { b.close(); }
});

for (const reason of ['停止', '换题', '关闭开关', '验证码']) {
    test(`${reason}使延迟AI结果失效，不执行答题或关闭`, async () => {
        const rows = [quizRow()];
        const b = browser(course + topic + '<iframe id="tcaptcha_iframe_dy" style="display:none"></iframe>', { settings: { apiKey: 'sk-test' }, setup: quizComponent(rows), deferAI: true });
        try {
            await b.flush(); assert.equal(b.requests.length, 1);
            if (reason === '停止') b.control.stop('测试停止');
            if (reason === '换题') {
                const replacement = quizRow('单选题', 399, '已经切换的问题');
                b.fixture.vm.pageList = replacement;
                b.fixture.vm.topicInfo.lessonTestQuestionUseInterfaceDtos = [replacement];
                b.fixture.render();
            }
            if (reason === '关闭开关') {
                const checkbox = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#auto-quiz');
                checkbox.checked = false; checkbox.dispatchEvent(new b.w.Event('change'));
            }
            if (reason === '验证码') b.w.document.querySelector('#tcaptcha_iframe_dy').style.display = 'block';
            // 不先执行轮询，响应处理必须实时校验上下文。
            respond(b.requests[0]); await b.flush();
            assert.equal(b.fixture.calls.length, 0);
            assert.equal(b.fixture.closes.length, 0);
            assert.equal(rows[0].isCheck, false);
            assert.equal(b.media.playCalls, 0);
        } finally { b.close(); }
    });
}

test('同题请求去重，失败后轮询不无限重试', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
    try {
        await b.flush(); await b.tick(); await b.tick();
        assert.equal(b.requests.length, 1, '等待响应期间同题不能并发请求');
        b.requests[0].onerror({ status: 0, error: 'offline' });
        await b.flush();
        let responded = 1;
        for (let i = 0; i < 12; i++) {
            await b.tick(60000);
            while (responded < b.requests.length) {
                b.requests[responded++].onerror({ status: 0, error: 'still offline' });
                await b.flush();
            }
        }
        assert.ok(b.requests.length <= 3, '失败重试有上限');
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
    } finally { b.close(); }
});

test('无效答案和限流响应保持暂停且不作答', async () => {
    for (const response of [
        { status: 429, responseText: '{"error":{"message":"rate limited"}}' },
        { status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"answers":[{"id":1,"letters":["Z"]}]}' } }] }) },
    ]) {
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
        try {
            await b.flush(); b.requests[0].onload(response); await b.flush(); await b.tick();
            assert.equal(b.fixture.calls.length, 0);
            assert.equal(b.fixture.closes.length, 0);
            assert.equal(b.media.playCalls, 0);
        } finally { b.close(); }
    }
});

test('智慧树将超过页面上限的已保存倍速限制到1.8x', async () => {
    for (const rate of [1.8, 2, 2.5, 3]) {
        const b = browser(course, { settings: { rate } });
        try { await b.flush(); assert.equal(b.video.playbackRate, 1.8); assert.equal(b.video.defaultPlaybackRate, 1.8); }
        finally { b.close(); }
    }
});

test('智慧树迁移并保存超过1.8x的旧设置', async () => {
    const saved = [];
    const b = browser(course, { settings: { rate: 4 }, setup(w) {
        w.GM_setValue = (key, value) => saved.push([key, value]);
    } });
    try {
        await b.flush();
        const select = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#rate');
        assert.equal(select.value, '1.8');
        assert.equal(b.video.playbackRate, 1.8);
        assert.equal(b.video.defaultPlaybackRate, 1.8);
        assert.ok(saved.some(([key, value]) => key === 'rate' && value === 1.8));
    } finally { b.close(); }
});

test('只有#app深层子组件持有课程数据时仍可找到并切节', async () => {
    const b = browser(crossChapterCourse, { setup(w) {
        const fixture = courseComponent(w);
        delete w.document.querySelector('.chapterScrollbar').__vue__;
        return fixture;
    } });
    try {
        await b.flush(); b.control.app.nextUnit(); await b.flush();
        assert.equal(b.fixture.calls.length, 1);
        assert.equal(b.fixture.calls[0][2], b.fixture.next);
    } finally { b.close(); }
});

test('弹题组件数据和可见题干不一致时仅建议，不操作组件', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup(w) {
        const fixture = quizComponent([quizRow()])(w);
        fixture.vm.pageList.testQuestion.name = '组件内的其他题';
        return fixture;
    } });
    try {
        await b.flush(); await b.tick();
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
        assert.equal(b.media.playCalls, 0);
    } finally { b.close(); }
});

test('页面方法没有更新选中状态时不重复操作或关闭弹题', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup(w) {
        const fixture = quizComponent([quizRow()])(w);
        fixture.vm.topicClickQot = (...args) => fixture.calls.push(args);
        return fixture;
    } });
    try {
        await b.flush(); await b.tick(); await b.tick();
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.calls.length, 1);
        assert.equal(b.fixture.closes.length, 0);
        assert.equal(b.media.playCalls, 0);
    } finally { b.close(); }
});

test('学习通面板继续提供3x选项', async () => {
    const b = browser(course, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=test', settings: { rate: 3 } });
    try {
        await b.flush();
        const select = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#rate');
        assert.equal(select.value, '3');
        assert.equal(select.querySelector('option[value="3"]').disabled, false);
    } finally { b.close(); }
});

test('真实跨章目录只读取当前chapterScrollbar，不混入无关目录', async () => {
    const unrelated = '<aside class="chapterScrollbar"><ul class="list"><li class="video"><span class="catalogue_title">其他课程视频</span></li></ul></aside>';
    const b = browser(crossChapterCourse + unrelated, { setup: courseComponent });
    try {
        await b.flush(); b.control.app.nextUnit(); await b.flush();
        assert.equal(b.fixture.calls.length, 1);
        assert.equal(b.fixture.calls[0][2], b.fixture.next);
    } finally { b.close(); }
});

test('真实组件的下一视频锁定时不调用videoClick', async () => {
    const b = browser(crossChapterCourse.replace('<li class="video"><span class="catalogue_title">下一视频', '<li class="video locked"><span class="catalogue_title">下一视频'), { setup: courseComponent });
    try {
        await b.flush(); b.control.app.nextUnit(); await b.flush();
        assert.equal(b.fixture.calls.length, 0);
    } finally { b.close(); }
});

test('AI作答过程中题目切换后不继续选择后续答案或关闭', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, aiResponse: { answers: [{ id: 1, letters: ['A', 'C'] }] }, setup(w) {
        const fixture = quizComponent([quizRow('多选题')])(w);
        const select = fixture.vm.topicClickQot;
        fixture.vm.topicClickQot = (...args) => {
            select(...args);
            const replacement = quizRow('多选题', 399, '下一道题');
            fixture.vm.pageList = replacement;
            fixture.vm.topicInfo.lessonTestQuestionUseInterfaceDtos = [replacement];
            fixture.render();
        };
        return fixture;
    } });
    try {
        await b.flush();
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.calls.length, 1, '第一项后上下文变化必须终止');
        assert.equal(b.fixture.closes.length, 0);
        assert.equal(b.fixture.vm.pageList.isCheck, false);
    } finally { b.close(); }
});

test('修改Key后到达的旧AI结果不作答或关闭', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
    try {
        await b.flush(); assert.equal(b.requests.length, 1);
        const key = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#key');
        key.value = 'sk-new-key'; key.dispatchEvent(new b.w.Event('input'));
        respond(b.requests[0]); await b.flush();
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
    } finally { b.close(); }
});

test('短暂网络错误在冷却后重试并正常作答，冷却前不重复请求', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
    try {
        await b.flush(); b.requests[0].onerror({ error: 'offline' }); await b.flush();
        await b.tick(1999);
        assert.equal(b.requests.length, 1);
        await b.tick(1);
        assert.equal(b.requests.length, 2);
        respond(b.requests[1]); await b.flush(); await b.tick();
        assert.equal(b.fixture.calls.length, 1);
        assert.equal(b.fixture.closes.length, 1);
        assert.equal(b.media.playCalls, 1);
    } finally { b.close(); }
});

test('401和402不是短暂错误，不自动重试或操作题目', async () => {
    for (const status of [401, 402]) {
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
        try {
            await b.flush(); b.requests[0].onload({ status, responseText: '{"error":{"message":"unauthorized or balance"}}' }); await b.flush();
            for (let i = 0; i < 5; i++) await b.tick(60000);
            assert.equal(b.requests.length, 1);
            assert.equal(b.fixture.calls.length, 0);
            assert.equal(b.fixture.closes.length, 0);
        } finally { b.close(); }
    }
});

test('冷却期间停止后不会再发送AI请求', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
    try {
        await b.flush(); b.requests[0].ontimeout({}); await b.flush();
        b.control.stop('停止重试'); await b.tick(60000);
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.calls.length, 0);
    } finally { b.close(); }
});

test('停止后到达的解析错误响应不会触发内部解析重试请求', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
    try {
        await b.flush(); b.control.stop('停止');
        b.requests[0].onload({ status: 200, responseText: 'invalid JSON' }); await b.flush();
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.calls.length, 0);
    } finally { b.close(); }
});

test('分页中内容相同但questionId不同的题分别作答并复用答案缓存', async () => {
    const rows = [quizRow('单选题', 301), quizRow('单选题', 302)];
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent(rows) });
    try {
        await b.flush(); for (let i = 0; i < 4; i++) await b.tick();
        assert.equal(b.requests.length, 1);
        assert.deepEqual(b.fixture.calls.map(call => call.questionId), [301, 302]);
        assert.ok(rows.every(row => row.isCheck));
        assert.equal(b.fixture.closes.length, 1);
    } finally { b.close(); }
});

test('智慧树倍速面板禁用超过1.8x的选项', async () => {
    const b = browser(course, { settings: { rate: 3 } });
    try {
        await b.flush();
        const select = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#rate');
        assert.equal(select.value, '1.8');
        for (const rate of [1.8, 2, 2.5, 3]) {
            const option = select.querySelector(`option[value="${rate}"]`);
            assert.ok(option);
            assert.equal(option.disabled, rate > 1.8);
        }
    } finally { b.close(); }
});

test('智慧树面板拒绝超过1.8x的设置并将上限沿用到后续视频', async () => {
    const saved = [];
    const b = browser(course, { setup(w) {
        w.GM_setValue = (key, value) => saved.push([key, value]);
    } });
    try {
        await b.flush();
        const select = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#rate');
        select.value = '3';
        select.dispatchEvent(new b.w.Event('change'));
        await b.flush();
        assert.equal(select.value, '1.8');
        assert.ok(saved.some(([key, value]) => key === 'rate' && value === 1.8));
        assert.equal(b.video.playbackRate, 1.8);
        assert.equal(b.video.defaultPlaybackRate, 1.8);

        const next = b.w.document.createElement('video');
        next.id = b.video.id;
        next.src = 'next.mp4';
        next.play = async () => {};
        next.pause = () => {};
        b.video.replaceWith(next);
        await b.tick();
        assert.equal(next.playbackRate, 1.8);
        assert.equal(next.defaultPlaybackRate, 1.8);
    } finally { b.close(); }
});

const scriptWarning = '<div class="el-message-box__wrapper"><div role="dialog">检测到异常脚本，为保证您的正常学习进度，请您关闭插件后，回到学堂重新进入视频学习页正常学习</div></div>';

test('异常脚本提示使自动化彻底停止并释放倍速控制，不自动重启', async () => {
    const saved = [];
    const b = browser(course, { settings: { rate: 1.8, lockRate: true }, setup(w) {
        w.GM_setValue = (key, value) => saved.push([key, value]);
    } });
    try {
        await b.flush();
        const app = b.control.app;
        assert.equal(b.video.__xtRateLockInstalled, true);
        b.w.document.body.insertAdjacentHTML('beforeend', scriptWarning);
        await b.tick();
        assert.equal(b.control.app, null);
        assert.equal(app._destroyed, true);
        assert.equal(app._timer, null);
        assert.equal(b.media.paused, true);
        assert.equal(b.video.__xtRateLockInstalled, false);
        assert.equal(Object.getOwnPropertyDescriptor(b.video, 'playbackRate'), undefined);
        assert.equal(b.video.playbackRate, 1);
        assert.equal(b.video.defaultPlaybackRate, 1);
        assert.ok(saved.some(([key, value]) => key === 'rate' && value === 0));
        assert.ok(saved.some(([key, value]) => key === 'lockRate' && value === false));
        const shadow = b.w.document.querySelector('#xt-ds-host').shadowRoot;
        assert.equal(shadow.querySelector('#rate').value, '0');
        assert.equal(shadow.querySelector('#lock-rate').checked, false);
        assert.match(shadow.querySelector('#activity').textContent, /停用.*脚本.*学堂/);
        assert.ok(b.w.document.querySelector('.el-message-box__wrapper'), '保留平台警告供用户处理');

        const plays = b.media.playCalls;
        b.w.document.querySelector('.el-message-box__wrapper').remove();
        b.control.start();
        await b.tick();
        assert.equal(b.control.app, null);
        assert.equal(b.media.playCalls, plays);
    } finally { b.close(); }
});

test('加载时已显示异常脚本提示则不启动播放器自动化', async () => {
    const b = browser(course + scriptWarning, { settings: { rate: 3 } });
    try {
        await b.flush();
        assert.equal(b.control.app, null);
        assert.equal(b.media.playCalls, 0);
        assert.equal(b.video.__xtRateLockInstalled, undefined);
    } finally { b.close(); }
});

test('手动暂停后出现的弹题作答关闭也不恢复播放', async () => {
    const b = browser();
    try {
        await b.flush();
        b.media.paused = true; b.video.dispatchEvent(new b.w.Event('pause'));
        b.w.document.body.insertAdjacentHTML('beforeend', topic);
        quizComponent([quizRow()])(b.w);
        const key = b.w.document.querySelector('#xt-ds-host').shadowRoot.querySelector('#key');
        key.value = 'sk-test'; key.dispatchEvent(new b.w.Event('input'));
        await b.tick(); await b.tick();
        assert.equal(b.media.playCalls, 1);
        assert.equal(b.media.paused, true);
    } finally { b.close(); }
});

test('调用closeTest后弹题仍显示时保持暂停且不重复关闭', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup(w) {
        const fixture = quizComponent([quizRow()])(w);
        fixture.vm.closeTest = done => { fixture.closes.push(true); done(); };
        return fixture;
    } });
    try {
        await b.flush(); await b.tick(); await b.tick(60000);
        assert.equal(b.fixture.closes.length, 1);
        assert.equal(b.requests.length, 1);
        assert.equal(b.media.playCalls, 0);
    } finally { b.close(); }
});

for (const reason of ['验证码', '更换Key', '关闭后重开自动答题']) {
    test(`${reason}取消旧请求后同题可以重新请求并完成`, async () => {
        const b = browser(course + topic + '<iframe id="tcaptcha_iframe_dy" style="display:none"></iframe>', { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
        try {
            await b.flush(); assert.equal(b.requests.length, 1);
            const shadow = b.w.document.querySelector('#xt-ds-host').shadowRoot;
            const captcha = b.w.document.querySelector('#tcaptcha_iframe_dy');
            const checkbox = shadow.querySelector('#auto-quiz');
            if (reason === '验证码') captcha.style.display = 'block';
            if (reason === '更换Key') {
                const key = shadow.querySelector('#key');
                key.value = 'sk-replacement'; key.dispatchEvent(new b.w.Event('input'));
            }
            if (reason === '关闭后重开自动答题') { checkbox.checked = false; checkbox.dispatchEvent(new b.w.Event('change')); }
            await b.tick();
            respond(b.requests[0]); await b.flush();
            assert.equal(b.fixture.calls.length, 0, '旧请求不可操作页面');
            if (reason === '验证码') captcha.style.display = 'none';
            if (reason === '关闭后重开自动答题') { checkbox.checked = true; checkbox.dispatchEvent(new b.w.Event('change')); }
            await b.tick();
            assert.equal(b.requests.length, 2, '取消不等于失败或已答，同题应该允许新请求');
            if (reason === '更换Key') assert.equal(b.requests[1].headers.Authorization, 'Bearer sk-replacement');
            respond(b.requests[1]); await b.flush(); await b.tick();
            assert.equal(b.fixture.calls.length, 1);
            assert.equal(b.fixture.closes.length, 1);
        } finally { b.close(); }
    });
}

test('实际达到三次失败后，后续轮询不会重新开启三次重试', async () => {
    const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
    try {
        await b.flush();
        for (let i = 0; i < 3; i++) {
            assert.equal(b.requests.length, i + 1);
            b.requests[i].onerror({ error: 'offline' }); await b.flush();
            await b.tick(5000);
        }
        for (let i = 0; i < 6; i++) await b.tick(60000);
        assert.equal(b.requests.length, 3);
        assert.equal(b.fixture.calls.length, 0);
        assert.equal(b.fixture.closes.length, 0);
    } finally { b.close(); }
});

function asyncPageQuiz(w) {
    const fixture = quizComponent([quizRow()])(w);
    fixture.vm.testDialog = false;
    fixture.root.style.display = 'none';
    let finishLoad;
    fixture.vm.testDotClick = () => new Promise(resolve => { finishLoad = resolve; }).then(() => {
        // 对应真实页面接口 then：先暂停，再在同一任务打开弹题。
        w.document.querySelector('video').pause();
        fixture.vm.testDialog = true;
        fixture.root.style.display = 'block';
    });
    fixture.finishLoad = () => finishLoad();
    return fixture;
}

for (const manual of ['无', '打开题目前手动暂停', '加载题目期间手动暂停']) {
    test(`真实异步弹题暂停后恢复播放意图：${manual}`, async () => {
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: asyncPageQuiz, queuedPauseEvents: true });
        try {
            await b.flush(); assert.equal(b.media.playCalls, 1);
            if (manual === '打开题目前手动暂停') { b.video.pause(); await b.mediaTask(); }
            const loading = b.fixture.vm.testDotClick();
            if (manual === '加载题目期间手动暂停') { b.video.pause(); await b.mediaTask(); }
            b.fixture.finishLoad(); await loading;
            assert.equal(b.fixture.vm.testDialog, true);
            assert.equal(b.media.paused, true);
            await b.mediaTask();
            await b.tick(); await b.tick();
            assert.equal(b.fixture.closes.length, 1);
            assert.equal(b.media.playCalls, manual === '无' ? 2 : 1);
            assert.equal(b.media.paused, manual !== '无');
        } finally { b.close(); }
    });
}

for (const reason of ['自动答题关开', 'Key改回原值']) {
    test(`同一轮询间隔内${reason}也使旧结果失效并允许新请求`, async () => {
        const b = browser(course + topic, { settings: { apiKey: 'sk-test' }, setup: quizComponent([quizRow()]), deferAI: true });
        try {
            await b.flush(); assert.equal(b.requests.length, 1);
            const shadow = b.w.document.querySelector('#xt-ds-host').shadowRoot;
            if (reason === '自动答题关开') {
                const checkbox = shadow.querySelector('#auto-quiz');
                checkbox.checked = false; checkbox.dispatchEvent(new b.w.Event('change'));
                checkbox.checked = true; checkbox.dispatchEvent(new b.w.Event('change'));
            } else {
                const key = shadow.querySelector('#key');
                key.value = 'sk-other'; key.dispatchEvent(new b.w.Event('input'));
                key.value = 'sk-test'; key.dispatchEvent(new b.w.Event('input'));
            }
            // 最终设置恢复原值，期间没有轮询，旧请求仍必须被撤销。
            respond(b.requests[0]); await b.flush();
            assert.equal(b.fixture.calls.length, 0);
            assert.equal(b.fixture.closes.length, 0);
            await b.tick(); assert.equal(b.requests.length, 2);
            respond(b.requests[1]); await b.flush(); await b.tick();
            assert.equal(b.fixture.calls.length, 1);
            assert.equal(b.fixture.closes.length, 1);
        } finally { b.close(); }
    });
}

/* ------------------------------------------ 智慧树作业 / 考试页适配 */

const examUrl = 'https://examh5.zhihuishu.com/exam/test/9f2c';

// Element UI 结构的题干卡片：.el-radio-group / .el-checkbox-group 包住选项。
function choiceQuestion({ type = '单选题', title = '一加一等于多少？', options = ['一', '二', '三'], name = 'q1' } = {}) {
    const multi = type === '多选题';
    const item = multi ? 'el-checkbox' : 'el-radio';
    const group = multi ? 'el-checkbox-group' : 'el-radio-group';
    const inputBox = multi ? 'el-checkbox__input' : 'el-radio__input';
    const label = multi ? 'el-checkbox__label' : 'el-radio__label';
    return `<div class="question-item">
        <div class="q-title"><span class="q-type">${type}</span>${title}</div>
        <div class="${group}">${options.map((text, index) =>
            `<label class="${item}"><span class="${inputBox}"><input type="${multi ? 'checkbox' : 'radio'}" name="${name}" value="${'ABCDEFGH'[index]}"></span><span class="${label}">${'ABCDEFGH'[index]}. ${text}</span></label>`).join('')}</div>
    </div>`;
}

function fillQuestion({ type = '填空题', title = '水的化学式是____', blanks = 1 } = {}) {
    const fields = type === '简答题'
        ? '<div class="el-textarea"><textarea class="el-textarea__inner" rows="3"></textarea></div>'
        : Array.from({ length: blanks }, () => '<div class="el-input"><input type="text" class="el-input__inner"></div>').join('');
    return `<div class="question-item"><div class="q-title"><span class="q-type">${type}</span>${title}</div>${fields}</div>`;
}

function examPage(inner, footer = '') {
    return `<div class="exam-container"><div class="paper">${inner}</div>${footer}</div>`;
}

const waitReal = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drive(b, steps = 6, ms = 70) {
    for (let index = 0; index < steps; index++) {
        await b.tick(1200);
        await waitReal(ms);
    }
    await b.flush();
}

function shadowOf(b) {
    return b.w.document.querySelector('#xt-ds-host').shadowRoot;
}

function selectedValues(b, name) {
    return Array.from(b.w.document.querySelectorAll(`input[name="${name}"]`))
        .filter(input => input.checked).map(input => input.value);
}

test('元数据覆盖智慧树作业/考试页面', () => {
    assert.match(source, /@match\s+\*:\/\/examh5\.zhihuishu\.com\/\*/);
    assert.match(source, /@match\s+\*:\/\/exam\.zhihuishu\.com\/\*/);
    assert.match(source, /@match\s+\*:\/\/\*\.zhihuishu\.com\/\*/);
});

test('宽匹配下非学习/考试页面不注入面板', async () => {
    const b = browser('<div>普通页面</div>', { url: 'https://www.zhihuishu.com/career/index' });
    try {
        await b.flush();
        assert.equal(b.w.document.querySelector('#xt-ds-host'), null);
        assert.equal(b.w.__xtDs, undefined);
    } finally { b.w.close(); }
});

test('作业/考试页自动接管：面板切到交卷布局，不要求课程目录', async () => {
    const b = browser(examPage(choiceQuestion()), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
    });
    try {
        await b.flush();
        const shadow = shadowOf(b);
        assert.ok(b.control.app, '作业/考试页应直接创建适配器，而不是等待 #coursetree');
        assert.equal(b.control.app._stepTitle, '作业/考试');
        assert.ok(shadow.getElementById('panel').classList.contains('quiz'), '面板应切到作业/考试布局');
        assert.equal(shadow.getElementById('auto-submit').checked, false, '面板交卷开关应反映已保存的设置');
        assert.match(shadow.textContent, /智慧树作业\/考试学习助手/);
        assert.equal(b.w.confirm, b.confirm, '考试页不改写原生 confirm');
    } finally { b.close(); }
});

test('识别题目并按 AI 答案自动选择单选，关闭自动交卷时只提示手动交卷', async () => {
    const b = browser(examPage(choiceQuestion()), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        aiResponse: { answers: [{ id: 1, letters: ['B'], restored: '一加一等于多少？' }] },
    });
    try {
        await drive(b);
        assert.deepEqual(selectedValues(b, 'q1'), ['B']);
        const shadow = shadowOf(b);
        assert.match(shadow.getElementById('log').textContent, /本页 1 道题已作答/);
        assert.match(shadow.getElementById('activity').textContent, /手动交卷/);
        assert.match(shadow.getElementById('chapter').textContent, /本页 1 题/);
    } finally { b.close(); }
});

test('多选题勾选多个选项，判断题按答案选择', async () => {
    const html = examPage(
        choiceQuestion({ type: '多选题', title: '下列哪些是偶数？', options: ['2', '3', '4'], name: 'q1' }) +
        choiceQuestion({ type: '判断题', title: '二大于一。', options: ['正确', '错误'], name: 'q2' }),
    );
    const b = browser(html, {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        aiResponse: { answers: [
            { id: 1, letters: ['A', 'C'], restored: '下列哪些是偶数？' },
            { id: 2, letters: ['A'], restored: '二大于一。' },
        ] },
    });
    try {
        await drive(b);
        assert.deepEqual(selectedValues(b, 'q1'), ['A', 'C']);
        assert.deepEqual(selectedValues(b, 'q2'), ['A']);
        assert.match(shadowOf(b).getElementById('log').textContent, /多选题/);
    } finally { b.close(); }
});

test('填空题按空数写入输入框并触发 input/change 事件', async () => {
    const b = browser(examPage(fillQuestion({ blanks: 2, title: '水的化学式是____，氧气是____。' })), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        aiResponse: { answers: [{ id: 1, text: ['H2O', 'O2'], restored: '化学式' }] },
    });
    try {
        const inputs = b.w.document.querySelectorAll('.question-item input');
        const events = [];
        inputs.forEach(input => ['input', 'change'].forEach(type => input.addEventListener(type, () => events.push(type))));
        await drive(b);
        assert.deepEqual(Array.from(inputs).map(input => input.value), ['H2O', 'O2']);
        assert.ok(events.includes('input'), '必须派发 input 事件供 Vue 同步');
        assert.ok(events.includes('change'), '必须派发 change 事件');
    } finally { b.close(); }
});

test('简答题写入 textarea', async () => {
    const answer = '物体在不受外力作用时保持静止或匀速直线运动。';
    const b = browser(examPage(fillQuestion({ type: '简答题', title: '简述牛顿第一定律。' })), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        aiResponse: { answers: [{ id: 1, text: [answer], restored: '牛顿第一定律' }] },
    });
    try {
        await drive(b);
        assert.equal(b.w.document.querySelector('.question-item textarea').value, answer);
    } finally { b.close(); }
});

test('“识别题目”输出题型、题干与选项', async () => {
    const b = browser(examPage(choiceQuestion() + fillQuestion({ blanks: 1 })), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        deferAI: true,
    });
    try {
        await b.flush();
        b.control.inspect();
        const log = shadowOf(b).getElementById('log').textContent;
        assert.match(log, /识别到 2 道题/);
        assert.match(log, /\[单选题\] 一加一等于多少/);
        assert.match(log, /\[填空题\]/);
        assert.match(log, /选项 3 个/);
    } finally { b.close(); }
});

test('自动交卷：点击交卷、确认弹窗后停止且不重复交卷', async () => {
    const b = browser(examPage(choiceQuestion(), '<button class="el-button" id="submit">交卷</button>'), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: true },
        aiResponse: { answers: [{ id: 1, letters: ['B'], restored: '一加一等于多少？' }] },
        setup(w) {
            const state = { clicks: 0, confirms: 0 };
            w.document.getElementById('submit').addEventListener('click', () => {
                state.clicks++;
                const box = w.document.createElement('div');
                box.className = 'el-message-box';
                box.innerHTML = '<p class="el-message-box__message">确定要交卷吗？</p><button class="el-button" id="ok">确定</button>';
                box.querySelector('#ok').addEventListener('click', () => {
                    state.confirms++;
                    w.document.querySelector('.paper').innerHTML = '<div class="result">已交卷，本次成绩 100 分</div>';
                    box.remove();
                });
                w.document.body.appendChild(box);
            });
            return state;
        },
    });
    try {
        for (let index = 0; index < 14; index++) { await b.tick(1200); await waitReal(120); }
        await b.flush();
        assert.equal(b.fixture.clicks, 1, '只能点一次交卷');
        assert.equal(b.fixture.confirms, 1, '应交卷确认一次');
        assert.equal(b.control.app._stepTitle, '已交卷');
        assert.match(shadowOf(b).getElementById('log').textContent, /交卷流程已完成/);
        for (let index = 0; index < 4; index++) { await b.tick(1200); await waitReal(60); }
        assert.equal(b.fixture.clicks, 1, '交卷完成后不能再次点击');
    } finally { b.close(); }
});

test('关闭自动交卷时不点交卷按钮', async () => {
    const b = browser(examPage(choiceQuestion(), '<button class="el-button" id="submit">交卷</button>'), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        aiResponse: { answers: [{ id: 1, letters: ['B'], restored: '一加一等于多少？' }] },
        setup(w) {
            const state = { clicks: 0 };
            w.document.getElementById('submit').addEventListener('click', () => { state.clicks++; });
            return state;
        },
    });
    try {
        await drive(b, 8);
        assert.equal(b.fixture.clicks, 0);
        assert.deepEqual(selectedValues(b, 'q1'), ['B'], '答案仍要填写');
        assert.match(shadowOf(b).getElementById('log').textContent, /未开启自动交卷/);
    } finally { b.close(); }
});

test('作业/考试页出现人工验证时暂停，不请求 AI', async () => {
    const b = browser(examPage(choiceQuestion(), '<iframe id="tcaptcha_iframe_dy"></iframe>'), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
    });
    try {
        await b.flush();
        assert.equal(b.requests.length, 0, '验证码可见时不能请求 AI');
        assert.match(shadowOf(b).getElementById('activity').textContent, /人工验证/);
    } finally { b.close(); }
});

test('AI 返回页面不存在的选项时停止且不交卷', async () => {
    const b = browser(examPage(choiceQuestion(), '<button class="el-button" id="submit">交卷</button>'), {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: true },
        aiResponse: { answers: [{ id: 1, letters: ['Z'], restored: '一加一等于多少？' }] },
        setup(w) {
            const state = { submits: 0 };
            w.document.getElementById('submit').addEventListener('click', () => { state.submits++; });
            return state;
        },
    });
    try {
        await drive(b, 5);
        assert.equal(b.fixture.submits, 0);
        assert.deepEqual(selectedValues(b, 'q1'), []);
        assert.match(shadowOf(b).getElementById('log').textContent, /不存在的选项/);
    } finally { b.close(); }
});

test('切题未渲染完成时不会重复点击“下一题”', async () => {
    const html = examPage(choiceQuestion(), '<button class="el-button" id="next">下一题</button>');
    const b = browser(html, {
        url: examUrl,
        settings: { apiKey: 'sk-test', autoSubmit: false },
        aiResponse: { answers: [{ id: 1, letters: ['B'], restored: '一加一等于多少？' }] },
        setup(w) {
            const state = { clicks: 0 };
            w.document.getElementById('next').addEventListener('click', () => { state.clicks++; });
            return state;
        },
    });
    try {
        for (let index = 0; index < 6; index++) { await b.tick(1200); await waitReal(90); }
        assert.equal(b.fixture.clicks, 1, '同一页在渲染完成前只能点一次下一题');
    } finally { b.close(); }
});

test('作业/考试页未填写 Key 时等待作答而不发请求', async () => {
    const b = browser(examPage(choiceQuestion()), { url: examUrl, settings: { autoSubmit: false } });
    try {
        await drive(b, 4);
        assert.equal(b.requests.length, 0);
        assert.match(shadowOf(b).getElementById('activity').textContent, /未填写 DeepSeek API Key/);
    } finally { b.close(); }
});

test('考试纯图片题干与选项都通过 image_url 发送，文字和上下标按顺序保留', async () => {
    const b = browser(examPage(choiceQuestion({
        title: '<p>x<sup>2</sup> + a<sub>n</sub>，先看<img src="/question-a.png" alt="公式甲">再看<img src="/question-b.png">求解</p>',
        options: ['<img src="/option-a.png">', '<img src="/option-b.png">'],
    })), { url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true });
    try {
        await b.flush();
        assert.equal(b.requests.length, 1, '不能丢弃纯图片选项');
        const question = b.control.app.inspectQuiz()[0];
        assert.match(question.question, /x\^\(2\).*a_\(n\).*\[图片1：公式甲\].*再看.*\[图片2\].*求解/);
        assert.equal(question.imageCount, 4);
        assert.deepEqual(Array.from(question.options), ['A. [图片1]', 'B. [图片1]']);
        const content = JSON.parse(b.requests[0].data).messages[1].content;
        assert.ok(Array.isArray(content), '应传递多模态内容');
        assert.deepEqual(content.filter(part => part.type === 'image_url').map(part => part.image_url.url), [
            'https://examh5.zhihuishu.com/question-a.png', 'https://examh5.zhihuishu.com/question-b.png',
            'https://examh5.zhihuishu.com/option-a.png', 'https://examh5.zhihuishu.com/option-b.png',
        ]);
    } finally { b.close(); }
});

for (const location of ['题干', '选项']) {
    test(`考试等待响应时${location}换图会丢弃旧结果并重新请求`, async () => {
        const b = browser(examPage(choiceQuestion({
            title: '根据图中公式<img src="/question.png">选择答案。',
            options: ['公式甲<img src="/a.png">', '公式乙<img src="/b.png">'],
        })), { url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true });
        try {
            await b.flush(); assert.equal(b.requests.length, 1);
            b.w.document.querySelector(location === '题干' ? '.q-title img' : '.el-radio__label img').src = '/replacement.png';
            respond(b.requests[0]); await b.flush();
            assert.deepEqual(selectedValues(b, 'q1'), [], '图片变化后旧答案不可写入');
            await b.tick();
            assert.equal(b.requests.length, 2, '相同占位文字但不同图片也要重新识别');
            respond(b.requests[1]); await b.flush();
            assert.deepEqual(selectedValues(b, 'q1'), ['B']);
        } finally { b.close(); }
    });
}

for (const reason of ['验证码', '保存Key', '自动答题关后重开']) {
    test(`考试请求期间${reason}撤销旧结果，同题随后可以恢复`, async () => {
        const b = browser(examPage(choiceQuestion(), '<iframe id="tcaptcha_iframe_dy" style="display:none"></iframe>'), {
            url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        });
        try {
            await b.flush(); assert.equal(b.requests.length, 1);
            const shadow = shadowOf(b), checkbox = shadow.querySelector('#auto-quiz');
            const captcha = b.w.document.querySelector('#tcaptcha_iframe_dy');
            if (reason === '验证码') { captcha.style.display = 'block'; await b.tick(); }
            if (reason === '保存Key') {
                const key = shadow.querySelector('#key');
                key.value = 'sk-replacement'; key.dispatchEvent(new b.w.Event('input'));
                shadow.querySelector('[data-act="save-key"]').click();
            }
            if (reason === '自动答题关后重开') {
                checkbox.checked = false; checkbox.dispatchEvent(new b.w.Event('change'));
                checkbox.checked = true; checkbox.dispatchEvent(new b.w.Event('change'));
            }
            respond(b.requests[0]); await b.flush();
            assert.deepEqual(selectedValues(b, 'q1'), [], '已撤销请求不能点击选项');
            if (reason === '验证码') captcha.style.display = 'none';
            await b.tick(); assert.equal(b.requests.length, 2, '同题可以重新请求');
            if (reason === '保存Key') assert.equal(b.requests[1].headers.Authorization, 'Bearer sk-replacement');
            respond(b.requests[1]); await b.flush();
            assert.deepEqual(selectedValues(b, 'q1'), ['B']);
        } finally { b.close(); }
    });
}

test('考试题干只有图片时仍可识别并请求', async () => {
    const b = browser(examPage(choiceQuestion({ title: '<img src="/question-only.png">' })), {
        url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
    });
    try {
        await b.flush();
        assert.equal(b.requests.length, 1);
        assert.equal(b.control.app.inspectQuiz()[0].imageCount, 1);
    } finally { b.close(); }
});

for (const reason of ['停止', '换题', '关闭自动答题', '更换Key']) {
    test(`考试多选第一个选项后${reason}时不再操作其余选项和下一题`, async () => {
        const b = browser(examPage(choiceQuestion({ type: '多选题' }), '<button id="next">下一题</button>'), {
            url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
            setup(w) {
                const state = { next: 0 };
                w.document.querySelector('#next').addEventListener('click', () => state.next++);
                w.document.querySelector('input[value="A"]').addEventListener('change', () => {
                    if (reason === '停止') w.__xtDs.stop('测试中途停止');
                    if (reason === '换题') w.document.querySelector('.q-title').innerHTML = '<span class="q-type">多选题</span>这是新题干';
                    const shadow = w.document.querySelector('#xt-ds-host').shadowRoot;
                    if (reason === '关闭自动答题') {
                        const checkbox = shadow.querySelector('#auto-quiz');
                        checkbox.checked = false; checkbox.dispatchEvent(new w.Event('change'));
                    }
                    if (reason === '更换Key') {
                        const key = shadow.querySelector('#key'); key.value = 'sk-new'; key.dispatchEvent(new w.Event('input'));
                    }
                });
                return state;
            },
        });
        try {
            await b.flush(); assert.equal(b.requests.length, 1);
            respond(b.requests[0], ['A', 'C']); await b.flush(); await b.flush();
            assert.deepEqual(selectedValues(b, 'q1'), ['A'], '上下文失效后不能继续勾选 C');
            assert.equal(b.fixture.next, 0, '取消之后不能翻页');
        } finally { b.close(); }
    });
}

test('考试相同内容但题号不同的分页分别填写', async () => {
    const b = browser(examPage(choiceQuestion({ name: 'question-101' })), {
        url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        setup(w) { w.document.querySelector('.question-item').dataset.questionId = '101'; },
    });
    try {
        await b.flush(); respond(b.requests[0]); await b.flush(); await b.flush();
        assert.deepEqual(selectedValues(b, 'question-101'), ['B']);
        b.w.document.querySelector('.paper').innerHTML = choiceQuestion({ name: 'question-102' });
        b.w.document.querySelector('.question-item').dataset.questionId = '102';
        await b.tick();
        assert.equal(b.requests.length, 2, '题号不同且未填写的下一页需要独立作答');
        respond(b.requests[1]); await b.flush(); await b.flush();
        assert.deepEqual(selectedValues(b, 'question-102'), ['B']);
    } finally { b.close(); }
});

test('考试下一题按钮暂时 disabled 时持续等待，不把当前页当末页交卷', async () => {
    const b = browser(examPage(choiceQuestion(), '<button id="next" disabled>下一题</button><button id="submit">交卷</button>'), {
        url: examUrl, settings: { apiKey: 'sk-test', autoSubmit: true },
        setup(w) {
            const state = { submits: 0, next: 0 };
            w.document.querySelector('#submit').addEventListener('click', () => state.submits++);
            w.document.querySelector('#next').addEventListener('click', () => state.next++);
            return state;
        },
    });
    try {
        await b.flush(); await b.flush();
        for (let i = 0; i < 6; i++) await b.tick(1200);
        assert.equal(b.fixture.submits, 0, '按钮存在但未启用不能证明已经末页');
        b.w.document.querySelector('#next').disabled = false;
        await b.tick();
        assert.equal(b.fixture.next, 1, '按钮恢复后正常翻页');
    } finally { b.close(); }
});

test('考试 contenteditable 已填草稿不作为题干，写入答案后不重复请求', async () => {
    const b = browser(examPage('<div class="question-item"><div class="q-title"><span class="q-type">简答题</span>简述水循环。</div><div contenteditable="true">学生已有的草稿</div></div>'), {
        url: examUrl, settings: { apiKey: 'sk-test' },
        aiResponse: { answers: [{ id: 1, text: ['蒸发、凝结和降水。'] }] },
        setup(w) {
            // jsdom 不提供 isContentEditable；真实浏览器中该属性由 contenteditable 派生。
            Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', {
                configurable: true, get() { return this.getAttribute('contenteditable') === 'true'; },
            });
        },
    });
    try {
        await b.flush(); await b.flush();
        assert.equal(b.control.app.inspectQuiz()[0].question, '简述水循环。', '富文本输入内容不能混入题干');
        assert.equal(b.w.document.querySelector('[contenteditable]').textContent, '蒸发、凝结和降水。');
        for (let i = 0; i < 5; i++) await b.tick(1200);
        assert.equal(b.requests.length, 1, '写入 contenteditable 不改变题目身份');
    } finally { b.close(); }
});

for (const [name, title, footer] of [
    ['题干引用提交成功', '阅读“提交成功”提示后，应如何核对成绩？', ''],
    ['题干引用得分', '若界面显示“得分：80”，应如何解释？', ''],
    ['隐藏结果模板', '一加一等于多少？', '<div class="result" style="display:none">考试已结束</div>'],
]) {
    test(`考试完成识别排除${name}`, async () => {
        const b = browser(examPage(choiceQuestion({ title }), footer), {
            url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        });
        try {
            await b.flush();
            assert.equal(b.requests.length, 1, '完成文案必须来自可见结果提示，题目仍需识别');
            assert.notEqual(b.control.app._stepTitle, '已交卷');
        } finally { b.close(); }
    });
}

test('考试可见结果区域的完成文案停止请求', async () => {
    const b = browser(examPage('', '<div class="result">已交卷，本次成绩 100 分</div>'), {
        url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
    });
    try {
        await b.flush(); await b.tick();
        assert.equal(b.requests.length, 0);
        assert.equal(b.control.app._stepTitle, '已交卷');
    } finally { b.close(); }
});

test('考试同页等待响应及填写完成后均不重复请求', async () => {
    const b = browser(examPage(choiceQuestion()), { url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true });
    try {
        await b.flush();
        for (let i = 0; i < 5; i++) await b.tick(1200);
        assert.equal(b.requests.length, 1, '等待期间同页只允许一个请求');
        respond(b.requests[0]); await b.flush(); await b.flush();
        for (let i = 0; i < 5; i++) await b.tick(1200);
        assert.equal(b.requests.length, 1, '已填同页不能再次调用 API');
        assert.deepEqual(selectedValues(b, 'q1'), ['B']);
    } finally { b.close(); }
});

test('考试自动交卷默认关闭，沿用原有 Key 只填答案', async () => {
    const b = browser(examPage(choiceQuestion(), '<button id="submit">交卷</button>'), {
        url: examUrl, settings: { apiKey: 'sk-existing' },
        setup(w) {
            const state = { submits: 0 };
            w.document.querySelector('#submit').addEventListener('click', () => state.submits++);
            return state;
        },
    });
    try {
        await b.flush(); await b.flush();
        assert.equal(shadowOf(b).querySelector('#auto-submit').checked, false);
        assert.equal(b.requests[0].headers.Authorization, 'Bearer sk-existing');
        for (let i = 0; i < 6; i++) await b.tick(1200);
        assert.deepEqual(selectedValues(b, 'q1'), ['B']);
        assert.equal(b.fixture.submits, 0);
    } finally { b.close(); }
});

test('考试同页 26 张图片分批请求，每批至多 24 张并正确映射全页题号', async () => {
    const html = Array.from({ length: 13 }, (_, index) => choiceQuestion({
        name: `batch-${index + 1}`, title: `批次题${index + 1}<img src="/question-${index + 1}.png">`,
        options: [`图示答案<img src="/option-${index + 1}.png">`, '文字答案'],
    })).join('');
    const b = browser(examPage(html), {
        url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        setup(w) {
            const request = w.GM_xmlhttpRequest;
            const state = { batches: [] };
            w.GM_xmlhttpRequest = details => {
                request(details);
                const content = JSON.parse(details.data).messages[1].content;
                const payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
                state.batches.push({ questions: payload.length, images: Array.isArray(content) ? content.filter(part => part.type === 'image_url').length : 0 });
                // 按每批自己的 id 回答，用全页题干编号交替选择，验证不能跨批错位。
                const answers = payload.map(item => ({
                    id: item.id, letters: [Number(item.question.match(/批次题(\d+)/)[1]) % 2 ? 'A' : 'B'],
                }));
                details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers }) } }] }) });
            };
            return state;
        },
    });
    try {
        for (let i = 0; i < 30; i++) await b.flush();
        assert.ok(b.requests.length >= 2, '整页 26 张图片不能作为单次超限请求');
        assert.ok(b.fixture.batches.every(batch => batch.images > 0 && batch.images <= 24), '每批必须保留图片并遵守 24 张上限');
        assert.equal(b.fixture.batches.reduce((sum, batch) => sum + batch.questions, 0), 13, '全部题目各请求一次');
        for (let i = 1; i <= 13; i++) {
            assert.deepEqual(selectedValues(b, `batch-${i}`), [i % 2 ? 'A' : 'B'], `第 ${i} 题应使用其对应批次答案`);
        }
    } finally { b.close(); }
});

test('考试原生 radio 通过题号和 name 分别识别同页两题', async () => {
    const html = [
        ['q1', '1. 一加一等于多少？', '一', '二'],
        ['q2', '2. 二加二等于多少？', '三', '四'],
    ].map(([name, title, a, b]) => `<div class="question-item"><div>${title}</div><div><label><input type="radio" name="${name}" value="A">A. ${a}</label><label><input type="radio" name="${name}" value="B">B. ${b}</label></div></div>`).join('');
    const b = browser(examPage(html), {
        url: examUrl, settings: { apiKey: 'sk-test' },
        aiResponse: { answers: [{ id: 1, letters: ['B'] }, { id: 2, letters: ['B'] }] },
    });
    try {
        await b.flush(); await b.flush();
        assert.equal(b.control.app.inspectQuiz().length, 2, '原生 input 分组不能把多道题合并');
        assert.deepEqual(selectedValues(b, 'q1'), ['B']);
        assert.deepEqual(selectedValues(b, 'q2'), ['B']);
    } finally { b.close(); }
});

test('考试填空题两个 textarea 按两个空请求并分别填写', async () => {
    const b = browser(examPage('<div class="question-item"><div>填空题 水的化学式是___，氧气是___。</div><textarea></textarea><textarea></textarea></div>'), {
        url: examUrl, settings: { apiKey: 'sk-test' },
        aiResponse: { answers: [{ id: 1, text: ['H2O', 'O2'] }] },
    });
    try {
        await b.flush(); await b.flush();
        assert.equal(b.requests.length, 1);
        const content = JSON.parse(b.requests[0].data).messages[1].content;
        assert.equal(JSON.parse(content)[0].blanks, 2, 'textarea 也可承载填空，不能漏计空数');
        assert.deepEqual(Array.from(b.w.document.querySelectorAll('.question-item textarea')).map(field => field.value), ['H2O', 'O2']);
    } finally { b.close(); }
});

test('考试同页连续三次设置取消不消耗失败次数，第四次请求仍能完成', async () => {
    const b = browser(examPage(choiceQuestion()), { url: examUrl, settings: { apiKey: 'sk-test' }, deferAI: true });
    try {
        await b.flush();
        for (let i = 0; i < 3; i++) {
            assert.equal(b.requests.length, i + 1);
            const shadow = shadowOf(b);
            if (i % 2 === 0) {
                const checkbox = shadow.querySelector('#auto-quiz');
                checkbox.checked = false; checkbox.dispatchEvent(new b.w.Event('change'));
                checkbox.checked = true; checkbox.dispatchEvent(new b.w.Event('change'));
            } else {
                const key = shadow.querySelector('#key');
                key.value = 'sk-replacement'; key.dispatchEvent(new b.w.Event('input'));
                shadow.querySelector('[data-act="save-key"]').click();
            }
            respond(b.requests[i]); await b.flush(); await b.flush();
            assert.deepEqual(selectedValues(b, 'q1'), []);
            assert.equal(b.control.app._failures.size, 0, '主动取消不能记作请求失败');
            assert.equal(b.control.app._fatal, false, '主动取消不能触发永久停止');
            await b.tick();
        }
        assert.equal(b.requests.length, 4, '三次取消后仍允许第四次请求');
        respond(b.requests[3]); await b.flush(); await b.flush();
        assert.deepEqual(selectedValues(b, 'q1'), ['B']);
    } finally { b.close(); }
});

test('考试下一题按钮暂时隐藏时持续等待，恢复显示后只翻页一次', async () => {
    const b = browser(examPage(choiceQuestion(), '<button id="next" hidden>下一题</button><button id="submit">交卷</button>'), {
        url: examUrl, settings: { apiKey: 'sk-test', autoSubmit: true },
        setup(w) {
            const state = { submits: 0, next: 0 };
            w.document.querySelector('#submit').addEventListener('click', () => state.submits++);
            w.document.querySelector('#next').addEventListener('click', () => state.next++);
            return state;
        },
    });
    try {
        await b.flush(); await b.flush();
        for (let i = 0; i < 6; i++) await b.tick(1200);
        assert.equal(b.fixture.submits, 0, '隐藏下一题不能作为末页证据');
        b.w.document.querySelector('#next').hidden = false;
        await b.tick(); await b.tick();
        assert.equal(b.fixture.next, 1, '恢复显示后同页只请求一次翻页');
    } finally { b.close(); }
});

/* 真实 onlineexamh5new 前端（公开模块 807/808/857/1364）的题目及保存结构。 */
const webExamUrl = 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html';

function webJudgeQuestion({ id = 'eid-101', number = 1, title = '一加一等于二。', options = ['错', '对'] } = {}) {
    return `<div class="examPaper_subject mt20">
        <div class="subject_stem clearfix"><div class="subject_type_describe fl">
            <div class="subject_num fl"><span id="anchor_${id}">${number}</span></div>
            <div class="subject_type_annex"><span class="subject_type"><span>【判断题】</span><span>(1分)</span></span></div>
            <div class="subject_describe dynamic-fonts"><div>${title}</div></div>
        </div></div>
        <div class="subject_node">${options.map((content, index) => `<div class="nodeLab"><div class="label clearfix">
            <div class="fl" style="padding:10px 0"><input class="mr30" type="radio" name="${id}" value="option-${index + 1}" style="display:none"><img class="flagChecked" src="/state.png"><span class="mr10">${'ABCDEFGH'[index]}.</span></div>
            <div class="node_detail examquestions-answer fl dynamic-fonts">${content}</div>
        </div></div>`).join('')}</div>
    </div>`;
}

function webExamPage(question, last = false) {
    return `<div id="app"><div class="examPaper">${question}</div><div class="switch-btn-box"><button class="el-button" disabled>上一题</button><button class="el-button" id="web-save-next">${last ? '保存' : '下一题'}</button></div><p class="switch-btn-warn">答题后请点【下一题】保存答案，全部试题答完后请点击右上角【提交】按钮完成答题，避免答题记录丢失！</p><button id="web-submit">提交</button></div>`;
}

function webJudgeSetup({ nextQuestion = null, multi = false } = {}) {
    return w => {
        const state = { optionClicks: [], saves: [], submits: 0, saved: false };
        const wireChoices = () => {
            for (const node of w.document.querySelectorAll('.nodeLab')) {
                node.addEventListener('click', () => {
                    const letter = node.querySelector('.mr10').textContent.replace('.', '');
                    state.optionClicks.push(letter);
                    if (!multi) for (const selected of w.document.querySelectorAll('.onChecked')) selected.classList.remove('onChecked');
                    node.querySelector('.mr10').classList.toggle('onChecked', multi ? !node.querySelector('.mr10').classList.contains('onChecked') : true);
                    node.querySelector('.node_detail').classList.toggle('onChecked', node.querySelector('.mr10').classList.contains('onChecked'));
                    // 公开前端 UpdateName 把 judges 设为 eid，hidden input.checked 不能代表选中。
                });
            }
        };
        wireChoices();
        w.document.querySelector('#web-submit').addEventListener('click', () => state.submits++);
        w.document.querySelector('#web-save-next').addEventListener('click', () => {
            state.saves.push(Array.from(w.document.querySelectorAll('.nodeLab .mr10.onChecked')).map(node => node.textContent.replace('.', '')).join(','));
        });
        state.finishSave = () => {
            state.saved = true;
            if (nextQuestion) {
                w.document.querySelector('.examPaper').innerHTML = nextQuestion;
                w.document.querySelector('#web-save-next').textContent = '保存';
                wireChoices();
            } else {
                const message = w.document.createElement('div'); message.className = 'el-message el-message--success';
                message.textContent = '保存成功'; w.document.body.appendChild(message);
            }
        };
        return state;
    };
}

test('真实新考试页识别自绘判断 A错B对，按 onChecked 选中并调用下一题保存一次', async () => {
    const b = browser(webExamPage(webJudgeQuestion()), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webJudgeSetup(), deferAI: true,
    });
    try {
        await b.flush();
        const questions = b.control.app.inspectQuiz();
        assert.equal(questions.length, 1, '没有可见 input 的自绘题目仍需识别');
        assert.equal(questions[0].type, '判断题');
        assert.equal(questions[0].question, '一加一等于二。');
        assert.deepEqual(Array.from(questions[0].options), ['A. 错', 'B. 对']);
        assert.equal(questions[0].imageCount, 0, 'flagChecked 图标不属于题目图片');
        assert.equal(b.requests.length, 1);
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['B']);
        assert.equal(b.w.document.querySelectorAll('input:checked').length, 0, '此真实结构由 onChecked 表示选中');
        assert.deepEqual(b.fixture.saves, ['B'], '点击下一题让原平台保存答案');
        await b.tick(); await b.tick();
        assert.equal(b.fixture.saves.length, 1, '保存响应未返回前不能重复点击下一题');
        assert.equal(b.fixture.submits, 0);
    } finally { b.close(); }
});

test('真实新考试页最后一道题点保存且默认不交卷，保存成功不误判已交卷', async () => {
    const b = browser(webExamPage(webJudgeQuestion(), true), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webJudgeSetup(), deferAI: true,
    });
    try {
        await b.flush();
        assert.equal(b.requests.length, 1, '最后一题也需要识别');
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.saves, ['B'], '最后题的保存按钮必须调用');
        b.fixture.finishSave();
        for (let i = 0; i < 5; i++) await b.tick(1200);
        assert.equal(b.fixture.saves.length, 1, '保存成功后不重复保存');
        assert.equal(b.fixture.submits, 0, '默认不点击提交');
        assert.notEqual(b.control.app._stepTitle, '已交卷', '保存成功与试卷提交成功不同');
    } finally { b.close(); }
});

test('真实新考试页下一题等待原平台异步保存成功后再处理后题', async () => {
    const b = browser(webExamPage(webJudgeQuestion()), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        setup: webJudgeSetup({ nextQuestion: webJudgeQuestion({ id: 'eid-102', number: 2, title: '二加二等于五。' }) }),
    });
    try {
        await b.flush(); assert.equal(b.requests.length, 1);
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.saves, ['B']);
        for (let i = 0; i < 3; i++) await b.tick(1200);
        assert.equal(b.requests.length, 1, '保存延迟时原题不重复请求');
        assert.equal(b.fixture.saves.length, 1, '保存延迟时下一题不连点');
        // 页面原saveSuccess事件只有返回成功才更新currentQuestionIndex并渲染下一题。
        b.fixture.finishSave();
        await b.tick();
        assert.equal(b.requests.length, 2, '平台确认保存并渲染后识别下一题');
        respond(b.requests[1], ['A']); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['B', 'A']);
        assert.deepEqual(b.fixture.saves, ['B', 'A'], '末题也要通过保存按钮保存');
        assert.equal(b.fixture.submits, 0);
    } finally { b.close(); }
});

test('真实新考试页封闭题干且组件不可达时明确暂停，不把题型分值当题干', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        setup(w) {
            const fixture = webJudgeSetup()(w);
            const stem = w.document.querySelector('.subject_describe > div');
            stem.attachShadow({ mode: 'closed' }).innerHTML = '<p>此处实际题干位于封闭 Shadow DOM 内。</p>';
            // 公开页面 hijackAllEls 会隐藏所有 __vue__，不能假设组件始终可访问。
            for (const element of w.document.querySelectorAll('*')) {
                Object.defineProperty(element, '__vue__', { configurable: true, get() {}, set() {} });
            }
            return fixture;
        },
    });
    try {
        await b.flush(); await b.tick();
        assert.equal(b.requests.length, 0, '题干不可读时禁止仅发送判断题/分值让模型猜');
        assert.equal(b.fixture.optionClicks.length, 0);
        assert.equal(b.fixture.saves.length, 0);
        assert.match(shadowOf(b).getElementById('activity').textContent, /题干.*(?:读取|不可|封闭|手动)|封闭.*题干/, '应向用户说明题干不可读取');
    } finally { b.close(); }
});

test('真实新考试页仅处理当前可见题，预渲染的隐藏题不请求不点击', async () => {
    const html = `<div>${webJudgeQuestion()}</div><div style="display:none">${webJudgeQuestion({ id: 'eid-hidden', number: 2, title: '尚未显示的下一题。' })}</div>`;
    const b = browser(webExamPage(html), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webJudgeSetup(), deferAI: true,
    });
    try {
        await b.flush();
        assert.equal(b.control.app.inspectQuiz().length, 1, 'v-show隐藏题不能并入当前页');
        assert.equal(b.requests.length, 1);
        const content = JSON.parse(b.requests[0].data).messages[1].content;
        const payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
        assert.equal(payload.length, 1);
        assert.doesNotMatch(payload[0].question, /尚未显示/);
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['B']);
        assert.equal(b.w.document.querySelectorAll('[style="display:none"] .onChecked').length, 0);
    } finally { b.close(); }
});

test('真实新考试页简答输入后先触发 blur 建立答案，再调用下一题保存', async () => {
    const question = webJudgeQuestion({ title: '简述水循环。' })
        .replace('【判断题】', '【简答题】').replace(/<div class="subject_node">[\s\S]*?<\/div>\s*<\/div>$/, '<div class="subject_node mt10"><textarea class="text_textarea" rows="20"></textarea></div></div>');
    const b = browser(webExamPage(question), {
        url: webExamUrl, settings: { apiKey: 'sk-test' },
        aiResponse: { answers: [{ id: 1, text: ['蒸发、凝结和降水。'] }] },
        setup(w) {
            const state = { input: '', answerDataTemp: '', events: [], saved: [] };
            const field = w.document.querySelector('textarea.text_textarea');
            assert.ok(field, '使用真实简答 textarea 结构');
            field.addEventListener('focus', () => state.events.push('focus'));
            field.addEventListener('input', () => { state.input = field.value; state.events.push('input'); });
            field.addEventListener('blur', () => { state.answerDataTemp = state.input; state.events.push('blur'); });
            w.document.querySelector('#web-save-next').addEventListener('click', () => {
                state.events.push('save'); state.saved.push(state.answerDataTemp);
            });
            return state;
        },
    });
    try {
        await b.flush(); await b.flush();
        assert.equal(b.requests.length, 1);
        assert.equal(b.w.document.querySelector('textarea').value, '蒸发、凝结和降水。');
        assert.ok(b.fixture.events.indexOf('focus') >= 0 && b.fixture.events.indexOf('focus') < b.fixture.events.indexOf('input'), '先激活真实输入框再更新文本');
        assert.ok(b.fixture.events.indexOf('blur') > b.fixture.events.indexOf('input'), '真实组件依赖 blur 提交输入状态');
        assert.ok(b.fixture.events.indexOf('save') > b.fixture.events.indexOf('blur'), '必须先准备答案再保存');
        assert.deepEqual(b.fixture.saved, ['蒸发、凝结和降水。']);
    } finally { b.close(); }
});

test('真实新考试页多选清除原有错误项并选中全部目标后保存', async () => {
    const question = webJudgeQuestion({ title: '下列哪些是偶数？', options: ['2', '3', '4'] })
        .replace('【判断题】', '【多选题】').replaceAll('type="radio"', 'type="checkbox"');
    const b = browser(webExamPage(question), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
        setup(w) {
            const fixture = webJudgeSetup({ multi: true })(w);
            const option = w.document.querySelectorAll('.nodeLab')[1];
            option.querySelector('.mr10').classList.add('onChecked'); option.querySelector('.node_detail').classList.add('onChecked');
            return fixture;
        },
    });
    try {
        await b.flush(); assert.equal(b.requests.length, 1);
        respond(b.requests[0], ['A', 'C']);
        for (let i = 0; i < 4; i++) await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['B', 'A', 'C']);
        assert.deepEqual(b.fixture.saves, ['A,C']);
        assert.equal(b.fixture.submits, 0);
    } finally { b.close(); }
});

test('真实新考试页图片只取题干与选项正文，状态图标不进入模型请求', async () => {
    const question = webJudgeQuestion({
        title: '<p>设x<sup>2</sup>，见<img src="/stem-1.png">求结果。</p>',
        options: ['<img src="/option-1.png">', '<img src="/option-2.png">'],
    }).replace('【判断题】', '【单选题】');
    const b = browser(webExamPage(question), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webJudgeSetup(), deferAI: true,
    });
    try {
        await b.flush(); assert.equal(b.requests.length, 1);
        const q = b.control.app.inspectQuiz()[0];
        assert.match(q.question, /x\^\(2\).*\[图片1\]/);
        assert.equal(q.imageCount, 3);
        const content = JSON.parse(b.requests[0].data).messages[1].content;
        assert.deepEqual(content.filter(part => part.type === 'image_url').map(part => part.image_url.url), [
            'https://onlineexamh5new.zhihuishu.com/stem-1.png',
            'https://onlineexamh5new.zhihuishu.com/option-1.png',
            'https://onlineexamh5new.zhihuishu.com/option-2.png',
        ]);
        assert.ok(content.filter(part => part.type === 'image_url').every(part => !part.image_url.url.endsWith('/state.png')));
    } finally { b.close(); }
});

const webExamDataUrl = 'https://taurusexam-api.zhihuishu.com/taurusExam/gateway/t/v1/student/doExam';
const webHomeworkDataUrl = 'https://studentexam-api.zhihuishu.com/studentExam/gateway/t/v1/student/doHomework';

function webExamQuestionData(overrides = {}) {
    return { eid: 'eid101', name: '<p>一加一等于二。</p>', questionType: { id: 14, name: '判断题' },
        questionOptions: [{ id: 'option-1', content: '错', flagChecked: false }, { id: 'option-2', content: '对', flagChecked: false }],
        questionDatas: [], ...overrides };
}

function webExamResponse(question = webExamQuestionData()) {
    return { status: 200, rt: { examBase: { workExamParts: [{ questionDtos: [question] }] } } };
}

function webExamXHRSetup({ url = webExamDataUrl } = {}) {
    return w => {
        const fixture = webJudgeSetup()(w);
        const stem = w.document.querySelector('.subject_describe > div');
        stem.replaceChildren();
        stem.attachShadow({ mode: 'closed' }).innerHTML = '<p>一加一等于二。</p>';
        for (const element of w.document.querySelectorAll('*')) {
            Object.defineProperty(element, '__vue__', { configurable: true, get() {}, set() {} });
        }
        const sent = [], opened = [], sendResult = {};
        class FixtureXHR extends w.EventTarget {
            constructor() { super(); this.status = 0; this.responseURL = ''; this.responseText = ''; this.response = ''; this.responseType = ''; }
            open(...args) { opened.push(args); }
            send(...args) { sent.push({ receiver: this, args }); return sendResult; }
            emit(data, { responseURL = url, status = 200, responseType = '' } = {}) {
                this.status = status; this.responseURL = responseURL; this.responseType = responseType;
                this.responseText = responseType === 'json' ? '' : JSON.stringify(data);
                this.response = responseType === 'json' ? data : this.responseText;
                this.dispatchEvent(new w.Event('load'));
            }
        }
        w.XMLHttpRequest = FixtureXHR;
        // 页面可在 userscript 执行前 new XHR，send 时仍应被正常监听。
        const xhr = new w.XMLHttpRequest();
        const original = { constructor: w.XMLHttpRequest, open: w.XMLHttpRequest.prototype.open,
            attachShadow: w.Element.prototype.attachShadow, send: w.XMLHttpRequest.prototype.send };
        return { ...fixture, xhr, sent, opened, sendResult, original };
    };
}

for (const url of [webExamDataUrl, webHomeworkDataUrl]) {
    test(`真实新考试页封闭题干从正常白名单 XHR 响应读取：${url.includes('doHomework') ? '作业' : '考试'}`, async () => {
        const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
            url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup({ url }), deferAI: true,
        });
        try {
            await b.flush(); assert.equal(b.requests.length, 0, '未获取匹配题干时保持等待');
            b.fixture.xhr.open('POST', url, true);
            b.fixture.xhr.send('fixture-page-body');
            b.fixture.xhr.emit(webExamResponse());
            await b.tick();
            assert.equal(b.requests.length, 1, '已匹配页面 eid/题型/选项后可以识别封闭题干');
            assert.equal(b.control.app.inspectQuiz()[0].question, '一加一等于二。');
            respond(b.requests[0]); await b.flush(); await b.flush();
            assert.deepEqual(b.fixture.optionClicks, ['B']);
            assert.deepEqual(b.fixture.saves, ['B']);
            assert.equal(b.fixture.sent.length, 1, '只观察页面请求，不重放请求');
        } finally { b.close(); }
    });
}

for (const url of [webExamDataUrl, webHomeworkDataUrl]) {
    test(`真实新考试页字符串成功状态读取并保存：${url.includes('doHomework') ? '作业' : '考试'}`, async () => {
        const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
            url: webExamUrl, settings: { apiKey: 'sk-test' }, deferAI: true,
            setup(w) {
                const fixture = webExamXHRSetup({ url })(w);
                // 真实响应的选项 ID 为数字，空附件与子题可返回 null。
                w.document.querySelectorAll('.nodeLab input').forEach((input, index) => { input.value = String(7001 + index); });
                return fixture;
            },
        });
        try {
            const question = webExamQuestionData({
                questionOptions: [{ id: 7001, content: '错' }, { id: 7002, content: '对' }],
                questionDatas: null, questionChildrens: null,
            });
            const data = webExamResponse(question);
            data.status = '200';
            b.fixture.xhr.send('fixture-page-body');
            b.fixture.xhr.emit(data, { responseType: url === webHomeworkDataUrl ? '' : 'json' });
            await b.tick();
            assert.equal(b.requests.length, 1, '字符串 200 应与数值 200 一样识别正常载题响应');
            assert.equal(b.control.app.inspectQuiz()[0].question, '一加一等于二。');
            respond(b.requests[0]); await b.flush(); await b.flush();
            assert.deepEqual(b.fixture.optionClicks, ['B']);
            assert.deepEqual(b.fixture.saves, ['B']);
            assert.equal(b.fixture.submits, 0);
            assert.equal(b.fixture.sent.length, 1, '不能重放正常载题请求');
        } finally { b.close(); }
    });
}

for (const status of ['401', '2000', true, '', null, 2000, '0200', ' 200 ', [200], { status: 200 }]) {
    test(`真实新考试页拒绝非成功状态：${JSON.stringify(status)}`, async () => {
        const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
            url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
        });
        try {
            const data = webExamResponse();
            data.status = status;
            b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(data);
            await b.tick();
            assert.equal(b.requests.length, 0, '只能接受精确的数值或字符串 200');
            assert.deepEqual(b.fixture.optionClicks, []);
            assert.deepEqual(b.fixture.saves, []);
        } finally { b.close(); }
    });
}

for (const mismatch of ['题号', '选项id', '选项内容', '题型', '非白名单URL', '接口状态']) {
    test(`真实新考试页 XHR ${mismatch}不匹配时不发题目请求`, async () => {
        const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
            url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
        });
        try {
            const question = webExamQuestionData();
            if (mismatch === '题号') question.eid = 'different-eid';
            if (mismatch === '选项id') question.questionOptions[1].id = 'wrong-option';
            if (mismatch === '选项内容') question.questionOptions[1].content = '错误内容';
            if (mismatch === '题型') question.questionType = { id: 1, name: '单选题' };
            const data = webExamResponse(question);
            if (mismatch === '接口状态') data.status = 401;
            b.fixture.xhr.send('fixture-page-body');
            b.fixture.xhr.emit(data, { responseURL: mismatch === '非白名单URL' ? 'https://example.com/student/doExam' : webExamDataUrl });
            await b.tick();
            assert.equal(b.requests.length, 0);
            assert.equal(b.fixture.optionClicks.length, 0);
            assert.equal(b.fixture.saves.length, 0);
        } finally { b.close(); }
    });
}

test('真实新考试页同 eid 的 XHR 题干更新撤销旧模型响应', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(webExamResponse());
        await b.tick(); assert.equal(b.requests.length, 1);
        b.fixture.xhr.emit(webExamResponse(webExamQuestionData({ name: '<p>一加一等于三。</p>' })));
        await b.tick();
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.equal(b.fixture.optionClicks.length, 0, '题干数据变化后不能写入旧答案');
        await b.tick(); assert.equal(b.requests.length, 2);
        assert.equal(b.control.app.inspectQuiz()[0].question, '一加一等于三。');
        respond(b.requests[1], ['A']); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['A']);
    } finally { b.close(); }
});

test('真实新考试页字符串成功状态更新题干撤销旧模型响应', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        const initial = webExamResponse(); initial.status = '200';
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(initial);
        await b.tick(); assert.equal(b.requests.length, 1);
        const updated = webExamResponse(webExamQuestionData({ name: '<p>一加一等于三。</p>' })); updated.status = '200';
        b.fixture.xhr.emit(updated);
        await b.tick();
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.equal(b.fixture.optionClicks.length, 0, '字符串成功状态更新也必须撤销旧答案');
        await b.tick(); assert.equal(b.requests.length, 2);
        assert.equal(b.control.app.inspectQuiz()[0].question, '一加一等于三。');
        respond(b.requests[1], ['A']); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['A']);
        assert.deepEqual(b.fixture.saves, ['A']);
    } finally { b.close(); }
});

test('真实新考试页观察 XHR 保持 constructor/open/attachShadow 及 send 原参返回不变', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        const { xhr, original, sendResult } = b.fixture;
        assert.equal(b.w.XMLHttpRequest, original.constructor);
        assert.equal(b.w.XMLHttpRequest.prototype.open, original.open);
        assert.equal(b.w.Element.prototype.attachShadow, original.attachShadow);
        assert.ok(xhr instanceof original.constructor);
        xhr.open('POST', webExamDataUrl, true);
        const body = { fixture: 'original-page-body' }, extra = { fixture: 'extra-argument' };
        assert.equal(xhr.send(body, extra), sendResult);
        assert.equal(b.fixture.sent.length, 1);
        assert.equal(b.fixture.sent[0].receiver, xhr);
        assert.equal(b.fixture.sent[0].args[0], body);
        assert.equal(b.fixture.sent[0].args[1], extra);
        const data = webExamResponse(); xhr.emit(data);
        const responseText = xhr.responseText;
        await b.tick();
        assert.equal(xhr.responseText, responseText);
        assert.equal(xhr.response, responseText);
        assert.equal(b.fixture.sent.length, 1);
        assert.equal(b.requests.length, 1, '保留原生语义的同时成功观察响应');
    } finally { b.close(); }
});

for (const mode of ['封闭题干', '可见题干']) {
    test(`真实新考试页字体映射未解码时${mode}均暂停自动请求`, async () => {
        const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
            url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
        });
        try {
            const data = webExamResponse();
            data.rt.examBase.ttfUrl = 'https://image.zhihuishu.com/fixture-encrypted-font.ttf';
            b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(data);
            if (mode === '可见题干') b.w.document.querySelector('.examPaper').innerHTML = webJudgeQuestion({ id: 'eid101', title: '画面呈现正常但底层字符可能被字体替换。' });
            await b.tick();
            assert.equal(b.requests.length, 0, '未确认字体映射不能把原始字符交给模型盲答');
            assert.match(shadowOf(b).getElementById('activity').textContent, /字体|编码|人工|手动/);
        } finally { b.close(); }
    });
}

test('真实新考试页支持正常 XHR responseType=json 的题目响应', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        const data = webExamResponse();
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(data, { responseType: 'json' });
        await b.tick();
        assert.equal(b.requests.length, 1);
        assert.equal(b.fixture.xhr.response, data, '不改写页面获取的原始 JSON 对象');
        assert.equal(b.fixture.xhr.responseText, '');
    } finally { b.close(); }
});

test('真实新考试页每份试卷响应替换缓存，不沿用上一份响应残留题目', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(webExamResponse());
        await b.tick(); assert.equal(b.requests.length, 1);
        b.fixture.xhr.emit(webExamResponse(webExamQuestionData({ eid: 'different-paper-eid' })));
        await b.tick();
        respond(b.requests[0]); await b.flush(); await b.tick();
        assert.equal(b.fixture.optionClicks.length, 0, '新试卷不含当前题时旧响应必须失效');
        assert.equal(b.requests.length, 1, '不得保留旧试卷题干并继续请求');
    } finally { b.close(); }
});

test('其他考试域名不安装新考试页专用 XHR 监听', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: examUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        assert.equal(b.w.XMLHttpRequest.prototype.send, b.fixture.original.send, '精准域名与路由外保持 send 原函数');
        assert.equal(b.w.XMLHttpRequest.prototype.open, b.fixture.original.open);
    } finally { b.close(); }
});

test('真实新考试页成功的空试卷响应清除旧缓存并撤销旧题响应', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(webExamResponse());
        await b.tick(); assert.equal(b.requests.length, 1);
        b.fixture.xhr.emit({ status: 200, rt: { examBase: { workExamParts: [] } } });
        await b.tick();
        respond(b.requests[0]); await b.flush(); await b.tick();
        assert.equal(b.fixture.optionClicks.length, 0, '成功空试卷不能继续使用旧缓存题干');
        assert.equal(b.requests.length, 1);
    } finally { b.close(); }
});

test('真实新考试页字符串成功的空试卷响应清除旧缓存并撤销旧题响应', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        const initial = webExamResponse(); initial.status = '200';
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(initial);
        await b.tick(); assert.equal(b.requests.length, 1);
        b.fixture.xhr.emit({ status: '200', rt: { examBase: { workExamParts: [] } } });
        await b.tick();
        respond(b.requests[0]); await b.flush(); await b.tick();
        assert.equal(b.fixture.optionClicks.length, 0, '字符串成功空试卷不能继续使用旧缓存题干');
        assert.equal(b.fixture.saves.length, 0);
        assert.equal(b.control.app.inspectQuiz().length, 0, '成功空响应必须替换整个题目快照');
        assert.equal(b.requests.length, 1);
    } finally { b.close(); }
});

test('真实新考试页 eid 净化保留连字符并匹配公开 anchor 规则', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid-101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        b.fixture.xhr.send('fixture-page-body');
        b.fixture.xhr.emit(webExamResponse(webExamQuestionData({ eid: 'eid-101' })));
        await b.tick();
        assert.equal(b.requests.length, 1, '公开净化规则保留连字符，不能误删导致漏题');
        respond(b.requests[0]); await b.flush(); await b.flush();
        assert.deepEqual(b.fixture.optionClicks, ['B']);
    } finally { b.close(); }
});

test('真实新考试页题目带附件时可见题干也不能漏附件请求', async () => {
    const b = browser(webExamPage(webJudgeQuestion({ id: 'eid101', title: '' })), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        b.fixture.xhr.send('fixture-page-body');
        b.fixture.xhr.emit(webExamResponse(webExamQuestionData({ questionDatas: [{ suffix: 'png', url: 'https://image.zhihuishu.com/fixture-attachment.png' }] })));
        b.w.document.querySelector('.examPaper').innerHTML = webJudgeQuestion({ id: 'eid101', title: '请结合本题附件判断。' });
        await b.tick();
        assert.equal(b.requests.length, 0, '附件未完整接入时不能回退为缺附件文字题');
        assert.equal(b.fixture.optionClicks.length, 0);
        assert.equal(b.fixture.saves.length, 0);
    } finally { b.close(); }
});

test('真实新考试页缓存含 questionChildrens 时不把复杂填空当作单题保存', async () => {
    const question = webJudgeQuestion({ id: 'eid101', title: '' }).replace('【判断题】', '【填空题】')
        .replace(/<div class="subject_node">[\s\S]*?<\/div>\s*<\/div>$/, '<div class="subject_node"><textarea></textarea></div></div>');
    const b = browser(webExamPage(question), {
        url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webExamXHRSetup(), deferAI: true,
    });
    try {
        const data = webExamQuestionData({ questionType: { id: 3, name: '填空题' }, name: '请根据各小题要求填写。',
            questionOptions: [], questionChildrens: [{ eid: 'child1', name: '水的化学式是什么？' }, { eid: 'child2', name: '氧气的化学式是什么？' }] });
        b.fixture.xhr.send('fixture-page-body'); b.fixture.xhr.emit(webExamResponse(data));
        await b.tick();
        assert.equal(b.requests.length, 0, '子题未适配时不能只回答父题干');
        assert.deepEqual(Array.from(b.w.document.querySelectorAll('textarea')).map(field => field.value), ['']);
        assert.equal(b.fixture.saves.length, 0);
        assert.match(shadowOf(b).getElementById('activity').textContent, /子题|复杂.*(?:手动|人工)/);
    } finally { b.close(); }
});

for (const childCount of [1, 2]) {
    test(`真实新考试页 ${childCount} 个编号子题需人工，禁止仅填写父题干后保存`, async () => {
        // 公开 render859：每个子题为外 div > .subject_node.mt10 > div，直接 [n] 文本 + span + textarea。
        const children = Array.from({ length: childCount }, (_, index) => `<div><div class="subject_node mt10"><div>
            [${index + 1}]
            <span>${index ? '氧气的化学式是____。' : '水的化学式是____。'}</span><br><textarea class="text_textarea" rows="3"></textarea>
        </div></div></div>`).join('');
        const question = webJudgeQuestion({ id: 'eid101', title: '请完成下列各小题。' }).replace('【判断题】', '【填空题】')
            .replace(/<div class="subject_node">[\s\S]*?<\/div>\s*<\/div>$/, `${children}</div>`);
        const b = browser(webExamPage(question), {
            url: webExamUrl, settings: { apiKey: 'sk-test' }, setup: webJudgeSetup(), deferAI: true,
        });
        try {
            await b.flush(); await b.tick();
            assert.equal(b.requests.length, 0, '编号小题结构不能降级为仅父题干或首空');
            assert.deepEqual(Array.from(b.w.document.querySelectorAll('textarea')).map(field => field.value), Array(childCount).fill(''));
            assert.equal(b.fixture.saves.length, 0);
            assert.match(shadowOf(b).getElementById('activity').textContent, /子题|复杂.*(?:手动|人工)/);
        } finally { b.close(); }
    });
}
