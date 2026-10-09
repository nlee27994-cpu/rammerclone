'use strict';

// Injected into every proxied top-level page (as hammerhead's "payload script").
// Adds a small floating button that leads back to the proxy's home page.
// Everything uses hammerhead's native (unwrapped) DOM methods so the proxy doesn't
// rewrite the button's link to point at the proxied site instead of the proxy itself.
module.exports = `
(function () {
    var hh = window['%hammerhead%'];

    if (!hh || window !== window.top)
        return;

    var native = hh.nativeMethods;

    function mount() {
        if (!document.documentElement)
            return setTimeout(mount, 50);

        var host = native.createElement.call(document, 'div');
        native.setAttribute.call(host, 'style', 'all:initial;position:fixed;z-index:2147483647;left:12px;bottom:12px;');

        var root = native.attachShadow.call(host, { mode: 'closed' });

        var style = native.createElement.call(document, 'style');
        native.appendChild.call(style, document.createTextNode(
            'a{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;' +
            'background:#6c5ce7;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35);opacity:.55;transition:opacity .15s;' +
            'text-decoration:none;font:20px/1 system-ui,sans-serif;cursor:pointer}' +
            'a:hover{opacity:1}'
        ));

        var link = native.createElement.call(document, 'a');
        native.setAttribute.call(link, 'href', '/');
        native.setAttribute.call(link, 'title', 'Back to proxy home');
        native.setAttribute.call(link, 'target', '_top');
        native.appendChild.call(link, document.createTextNode('\\u2302'));

        native.appendChild.call(root, style);
        native.appendChild.call(root, link);
        native.appendChild.call(document.documentElement, host);
    }

    if (document.readyState === 'loading')
        native.addEventListener.call(document, 'DOMContentLoaded', mount);
    else
        mount();
})();
`;
