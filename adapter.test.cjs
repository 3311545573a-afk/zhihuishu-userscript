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

test('不把智慧树考试页或无关域名分流到共享课自动化', async () => {
    const b = browser(course, { url: 'https://studyvideoh5.zhihuishu.com/exam' });
    try {
        await b.flush();
        assert.equal(b.control.app, null);
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

test('智慧树将旧设置2x和3x限制到1.8x', async () => {
    for (const rate of [2, 3]) {
        const b = browser(course, { settings: { rate } });
        try { await b.flush(); assert.equal(b.video.playbackRate, 1.8); assert.equal(b.video.defaultPlaybackRate, 1.8); }
        finally { b.close(); }
    }
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
        for (const option of select.options) if (Number(option.value) > 1.8) assert.equal(option.disabled, true);
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
