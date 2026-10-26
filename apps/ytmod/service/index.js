'use strict';

// Entry point of the YouTube mod's Tizen web service. The UI starts it; it
// relaunches the UI in debug mode, opens YouTube TV over DevTools and injects
// the userscript.

var path = require('path');
var tv = require('./lib/tv');
var storeLib = require('./lib/store');
var createInjector = require('./lib/injector').createInjector;
var createServer = require('./lib/server').createServer;

var PORT = Number(process.env.TBOX_PORT) || 8094;
var instance = null;

// The bundle runs from <app>/service/dist; the userscript is in <app>/userscript.
function bundledDir() {
    return process.env.TBOX_USERSCRIPT_DIR || path.resolve(__dirname, '..', '..', 'userscript');
}

function start() {
    if (instance) return;
    var store = storeLib.createStore(storeLib.findDataDir(tv.packageId()));
    var injector = createInjector({ tv: tv, store: store, bundledDir: bundledDir() });
    instance = createServer({ port: PORT, injector: injector, store: store, tv: tv, bundledDir: bundledDir() });
    instance.listen('127.0.0.1');
    injector.log(store.dataDir ? 'Settings folder: ' + store.dataDir : 'No writable data folder; settings will not persist');
}

process.on('uncaughtException', function (err) {
    console.error('[ytmod] uncaught: ' + (err && err.stack || err));
});

start();

module.exports.onStart = function () { start(); };
module.exports.onRequest = function () { start(); };
module.exports.onStop = function () { };
module.exports.onExit = function () { };
