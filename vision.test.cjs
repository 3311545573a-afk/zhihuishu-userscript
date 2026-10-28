const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'xuexitong-zhihuishu.user.js'), 'utf8');
const pure = source.split('/* __XT_PURE_BEGIN__ */')[1].split('/* __XT_PURE_END__ */')[0];
const { buildRequestBody, findThemeMismatches } = vm.runInNewContext(
    `${pure}\n({ buildRequestBody, findThemeMismatches })`, { URL },
);
const copy = value => JSON.parse(JSON.stringify(value));
const picture = (url = 'https://image.zhihuishu.com/formula.png', alt = '') => ({ url, alt });
const question = overrides => ({
    kind: '单选题', title: '设积分 I，求 I。',
    options: [{ letter: 'A', text: '一' }, { letter: 'B', text: '二' }],
    ...overrides,
});
const getPayload = body => JSON.parse(Array.isArray(body.messages[1].content) ? body.messages[1].content[0].text : body.messages[1].content);

test('纯文字请求保留字符串 JSON 和原有参数', () => {
    const body = buildRequestBody([question()], '请核对');
    assert.equal(typeof body.messages[1].content, 'string');
    assert.deepEqual(getPayload(body), [{ id: 1, type: '单选题', question: '设积分 I，求 I。', options: [{ letter: 'A', text: '一' }, { letter: 'B', text: '二' }] }]);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.max_tokens, 8000);
    assert.ok(body.messages[0].content.endsWith('\n请核对'));
});

test('题干和选项图片逐张以可追溯标签和 image_url 发送', () => {
    const questions = [question({ title: '设 [图片1：积分]，求 [图片2]。', images: [picture(undefined, '积分'), picture('https://image.zhihuishu.com/second.png')], options: [
        { letter: 'A', text: '[图片1]', images: [picture('https://image.zhihuishu.com/a.png')] },
        { letter: 'B', text: '文字加 [图片1：结果]', images: [picture('https://image.zhihuishu.com/b.png', '结果')] },
    ] })];
    const before = JSON.stringify(questions);
    const body = buildRequestBody(questions);
    const content = copy(body.messages[1].content);
    assert.ok(Array.isArray(content));
    assert.equal(content.length, 9);
    assert.equal(content[0].type, 'text');
    const item = getPayload(body)[0];
    assert.equal(item.question, questions[0].title);
    assert.equal(item.options[1].text, questions[0].options[1].text);
    assert.equal(item.image_labels.length, 2);
    assert.equal(item.options[0].image_labels.length, 1);
    assert.equal(item.options[1].image_labels.length, 1);
    assert.equal(content[1].text, item.image_labels[0]);
    assert.equal(content[3].text, item.image_labels[1]);
    assert.equal(content[5].text, item.options[0].image_labels[0]);
    assert.equal(content[7].text, item.options[1].image_labels[0]);
    assert.match(content[1].text, /第\s*1\s*题.*题干.*图片1/);
    assert.match(content[5].text, /第\s*1\s*题.*选项\s*A.*图片1/);
    assert.match(content[7].text, /第\s*1\s*题.*选项\s*B.*图片1/);
    const urls = questions[0].images.concat(questions[0].options.flatMap(option => option.images)).map(image => image.url);
    assert.deepEqual(content.filter(part => part.type === 'image_url').map(part => part.image_url), urls.map(url => ({ url, detail: 'original' })));
    assert.doesNotMatch(content[0].text, /https?:|data:image/);
    assert.equal(JSON.stringify(questions), before, '构造请求不修改页面抽取结果');
    assert.match(body.messages[0].content, /图片.*公式/);
});

test('多题图片标签保留题号，字段内序号从 1 开始', () => {
    const body = buildRequestBody([question(), question({ title: '[图片1]', images: [picture()] })]);
    const content = copy(body.messages[1].content);
    assert.equal(content.length, 3);
    assert.match(content[1].text, /第\s*2\s*题.*题干.*图片1/);
});

test('空图片数组仍走文字请求', () => {
    const body = buildRequestBody([question({ images: [], options: [{ letter: 'A', text: '一', images: [] }, { letter: 'B', text: '二', images: [] }] })]);
    assert.equal(typeof body.messages[1].content, 'string');
    assert.equal(getPayload(body)[0].image_labels, undefined);
});

test('图文题不受中文共同后缀主题校验干扰，纯文字题保持原检查', () => {
    const options = [{ letter: 'A', text: '高速铁路' }, { letter: 'B', text: '普通铁路' }];
    const imageQuestion = question({ images: [picture()], options });
    const textQuestion = question({ options });
    const body = buildRequestBody([imageQuestion, textQuestion]);
    assert.equal(getPayload(body)[0].theme, undefined);
    assert.equal(getPayload(body)[1].theme, '铁路');
    const mismatches = copy(findThemeMismatches([imageQuestion, textQuestion], [
        { id: 1, letters: ['A'], restored: '求积分' }, { id: 2, letters: ['A'], restored: '无主题' },
    ]));
    assert.deepEqual(mismatches.map(item => item.id), [2]);
});

for (const url of ['', '   ', 'javascript:alert(1)', 'file:///example/formula.png', 'blob:https://example.com/123', 'data:image/svg+xml;base64,AAAA', 'data:image/jpg;base64,AAAA', 'data:image/png,notbase64', 'data:image/png;base64,', 'data:image/png;base64,??==', 'not-a-url', 'https://']) {
    test(`非法或不支持的图片地址明确失败：${url.slice(0, 45) || '空值'}`, () => {
        assert.throws(() => buildRequestBody([question({ images: [picture(url)] })]), /图片.*(?:地址|格式|协议|内容)/);
    });
}

test('图片记录和列表格式错误时明确失败', () => {
    for (const images of [null, {}, 'https://example.com/a.png', [null], [{}], [{ url: 123 }]]) {
        assert.throws(() => buildRequestBody([question({ images })]), /图片/);
    }
});

test('HTTP 图片地址最多 8192 字符且保留查询参数', () => {
    const start = 'https://image.zhihuishu.com/formula.png?token=';
    const url = start + 'a'.repeat(8192 - start.length);
    const body = buildRequestBody([question({ images: [picture(url)] })]);
    assert.equal(body.messages[1].content[2].image_url.url, url);
    assert.throws(() => buildRequestBody([question({ images: [picture(url + 'a')] })]), /图片.*8192/);
});

test('单请求 24 张图片允许，25 张明确停止', () => {
    const images = Array.from({ length: 24 }, (_, index) => picture(`https://image.zhihuishu.com/${index}.png`));
    assert.equal(buildRequestBody([question({ images })]).messages[1].content.length, 49);
    assert.throws(() => buildRequestBody([question({ images: [...images, picture()] })]), /图片.*24/);
});

test('支持四种 base64 图片 MIME', () => {
    for (const mime of ['png', 'jpeg', 'gif', 'webp']) {
        const url = `data:image/${mime};base64,AAAA`;
        assert.equal(buildRequestBody([question({ images: [picture(url)] })]).messages[1].content[2].image_url.url, url);
    }
});

test('单张 dataURL 最多 8 MiB 字符', () => {
    const prefix = 'data:image/png;base64,';
    const url = prefix + 'A'.repeat(Math.floor((8 * 1024 * 1024 - prefix.length) / 4) * 4);
    assert.equal(buildRequestBody([question({ images: [picture(url)] })]).messages[1].content[2].image_url.url, url);
    assert.throws(() => buildRequestBody([question({ images: [picture(url + 'AAAA')] })]), /图片.*8\s*MiB/);
});

test('图片合计超过 24 MiB 字符时停止而非截断', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024);
    const three = buildRequestBody([question({ images: Array.from({ length: 3 }, () => picture(url)) })]);
    assert.equal(three.messages[1].content.length, 7);
    assert.throws(() => buildRequestBody([question({ images: Array.from({ length: 4 }, () => picture(url)) })]), /图片.*24\s*MiB/);
});
