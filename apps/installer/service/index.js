'use strict';

// Entry point of the Installer's Tizen web service (runs in the TV's Node
// runtime, separate from the UI). It keeps running in the background so the
// LAN upload page works whenever the TV is on.

var createInstallerServer = require('./lib/server').createInstallerServer;

var PORT = Number(process.env.TBOX_PORT) || 8093;
var instance = null;

function start() {
    if (instance) return;
    instance = createInstallerServer({ port: PORT });
    instance.listen('0.0.0.0');
}

process.on('uncaughtException', function (err) {
    if (instance) instance.log('Uncaught error: ' + (err && err.stack || err));
    else console.error(err);
});

if (typeof process.removeAllListeners === 'function') process.removeAllListeners('warning');

start();

// Tizen service lifecycle hooks.
module.exports.onStart = function () { start(); };
module.exports.onRequest = function () { start(); };
module.exports.onStop = function () { };
module.exports.onExit = function () { };
