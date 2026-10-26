'use strict';

// Reads the identity of a .wgt or .tpk from its manifest and checks whether
// it carries signatures. Uses JSZip only (no XML parser) to keep the bundle
// small; manifests are simple enough for attribute regexes.

var JSZip = require('jszip');

function attr(tag, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
    return m ? m[1] : null;
}

function firstTag(xml, tagName) {
    var m = new RegExp('<' + tagName.replace(':', '\\:') + '\\b[^>]*>').exec(xml);
    return m ? m[0] : null;
}

function textOf(xml, tagName) {
    var m = new RegExp('<' + tagName + '\\b[^>]*>([^<]*)</' + tagName + '>').exec(xml);
    return m ? m[1].trim() : null;
}

function parseWgtConfig(xml) {
    var widget = firstTag(xml, 'widget') || '';
    var app = firstTag(xml, 'tizen:application') || '';
    return {
        type: 'wgt',
        packageId: attr(app, 'package'),
        appId: attr(app, 'id'),
        version: attr(widget, 'version'),
        name: textOf(xml, 'name'),
        requiredVersion: attr(app, 'required_version')
    };
}

function parseTpkManifest(xml) {
    var manifest = firstTag(xml, 'manifest') || '';
    var uiApp = firstTag(xml, 'ui-application') || firstTag(xml, 'service-application') || '';
    return {
        type: 'tpk',
        packageId: attr(manifest, 'package'),
        appId: attr(uiApp, 'appid'),
        version: attr(manifest, 'version'),
        name: textOf(xml, 'label'),
        requiredVersion: attr(manifest, 'api-version')
    };
}

function inspectPackage(buffer) {
    return JSZip.loadAsync(buffer).then(function (zip) {
        var names = Object.keys(zip.files);
        var isWgt = names.indexOf('config.xml') !== -1;
        var isTpk = names.indexOf('tizen-manifest.xml') !== -1;
        if (!isWgt && !isTpk) {
            throw new Error('Not a Tizen package: no config.xml or tizen-manifest.xml inside');
        }
        var manifestName = isWgt ? 'config.xml' : 'tizen-manifest.xml';
        return zip.files[manifestName].async('string').then(function (xml) {
            var info = isWgt ? parseWgtConfig(xml) : parseTpkManifest(xml);
            info.signed = names.indexOf('author-signature.xml') !== -1 &&
                names.some(function (n) { return /^signature\d+\.xml$/.test(n); });
            info.fileCount = names.length;
            if (!info.packageId) throw new Error('Could not read the package id from ' + manifestName);
            return info;
        });
    });
}

module.exports = {
    inspectPackage: inspectPackage,
    parseWgtConfig: parseWgtConfig,
    parseTpkManifest: parseTpkManifest
};
