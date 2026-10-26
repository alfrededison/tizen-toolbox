'use strict';

const test = require('node:test');
const assert = require('node:assert');

// tv.js uses the global `tizen` object of the TV's web service runtime.
function withTizen(t, application) {
    global.tizen = { application, ApplicationControl: function (op) { this.operation = op; } };
    t.after(() => { delete global.tizen; });
    delete require.cache[require.resolve('../apps/installer/service/lib/tv')];
    return require('../apps/installer/service/lib/tv');
}

test('launch falls back to the default app control when launch() is refused', async (t) => {
    const calls = [];
    const tv = withTizen(t, {
        launch: (id, ok, fail) => { calls.push('launch ' + id); fail({ message: 'NotFoundError' }); },
        launchAppControl: (ctrl, id, ok) => { calls.push('appcontrol ' + id + ' ' + ctrl.operation); ok(); },
    });
    await tv.launch('AbCdE12345.App');
    assert.deepStrictEqual(calls, ['launch AbCdE12345.App', 'appcontrol AbCdE12345.App http://tizen.org/appcontrol/operation/default']);
});

test('launch reports both errors when the app control fails too', async (t) => {
    const tv = withTizen(t, {
        launch: (id, ok, fail) => fail({ message: 'NotFoundError' }),
        launchAppControl: (ctrl, id, ok, fail) => fail({ message: 'InvalidValuesError' }),
    });
    await assert.rejects(tv.launch('AbCdE12345.App'), /NotFoundError; via app control: InvalidValuesError/);
});
