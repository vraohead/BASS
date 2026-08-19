// float.js — BASS floating-panel overlay (injected on demand into the active
// page when the associate selects the "Floating panel" display mode).
//
// It hosts the real BASS UI inside a chrome-extension iframe, wrapped in a small
// draggable + resizable frame. Injected via chrome.scripting.executeScript from
// background.js, so it only runs on pages where the associate has granted BASS
// site access. The iframe loads sidepanel.html?mode=float and behaves exactly
// like the side panel; this file only provides the movable/resizable container.
(function () {
  'use strict';

  var HOST_ID = 'bass-float-host';

  // Re-injection (e.g. the associate clicks the toolbar icon again): if the
  // overlay already exists, just reveal it instead of stacking another one.
  var current = document.getElementById(HOST_ID);
  if (current) { current.style.visibility = ''; current.style.display = 'flex'; return; }

  var DEFAULTS = { width: 400, height: 660, left: 24, top: 24 };
  var MIN_W = 300, MIN_H = 380;

  // Wire page-level listeners once, even across re-injections:
  //  - FLOAT_SET_VISIBLE: background hides the overlay during a tab capture so
  //    BASS itself is excluded from the screenshot, then restores it.
  //  - BASS_FLOAT_REMOVE: the iframe asks to remove the overlay (e.g. when the
  //    associate switches to another display mode).
  if (!window.__bassFloatWired) {
    window.__bassFloatWired = true;
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.action === 'FLOAT_SET_VISIBLE') {
          var h = document.getElementById(HOST_ID);
          if (h) h.style.visibility = msg.visible ? '' : 'hidden';
        }
      });
    } catch (_) {}
    window.addEventListener('message', function (e) {
      if (e && e.data && e.data.type === 'BASS_FLOAT_REMOVE') {
        var h = document.getElementById(HOST_ID);
        if (h) h.remove();
      }
    });
  }

  try {
    chrome.storage.local.get('floatBounds', function (r) {
      build((r && r.floatBounds) || DEFAULTS);
    });
  } catch (_) { build(DEFAULTS); }

  function clampBounds(b) {
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var width  = Math.max(MIN_W, Math.min((b && b.width)  || DEFAULTS.width,  vw));
    var height = Math.max(MIN_H, Math.min((b && b.height) || DEFAULTS.height, vh));
    var left = (b && b.left != null) ? b.left : DEFAULTS.left;
    var top  = (b && b.top  != null) ? b.top  : DEFAULTS.top;
    left = Math.max(0, Math.min(left, vw - 80));
    top  = Math.max(0, Math.min(top,  vh - 60));
    return { width: width, height: height, left: left, top: top };
  }

  function saveBounds(b) {
    try { chrome.storage.local.set({ floatBounds: b }); } catch (_) {}
  }

  function setStyles(el, styles) {
    for (var k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) el.style[k] = styles[k];
    }
  }

  function build(rawBounds) {
    var b = clampBounds(rawBounds || DEFAULTS);

    var host = document.createElement('div');
    host.id = HOST_ID;
    setStyles(host, {
      position: 'fixed', left: b.left + 'px', top: b.top + 'px',
      width: b.width + 'px', height: b.height + 'px',
      zIndex: '2147483647', background: '#0b0d14',
      border: '1px solid rgba(255,255,255,0.14)', borderRadius: '12px',
      boxShadow: '0 14px 50px rgba(0,0,0,0.55)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      colorScheme: 'dark'
    });

    // Title / drag bar (the iframe swallows mouse events, so the overlay needs
    // its own drag surface outside it).
    var bar = document.createElement('div');
    setStyles(bar, {
      flex: '0 0 auto', height: '30px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', padding: '0 6px 0 10px', cursor: 'move',
      background: 'linear-gradient(135deg, rgba(108,143,255,0.22), rgba(167,139,250,0.18))',
      borderBottom: '1px solid rgba(255,255,255,0.10)', userSelect: 'none'
    });
    var title = document.createElement('span');
    title.textContent = 'BASS';
    setStyles(title, {
      fontFamily: 'Inter, system-ui, sans-serif', fontSize: '11px',
      fontWeight: '800', letterSpacing: '0.12em', color: '#e2e8f0'
    });
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.title = 'Close';
    setStyles(closeBtn, {
      border: 'none', background: 'transparent', color: '#cbd5e1',
      fontSize: '13px', lineHeight: '1', cursor: 'pointer',
      padding: '4px 6px', borderRadius: '6px'
    });
    closeBtn.addEventListener('mouseenter', function () { closeBtn.style.background = 'rgba(255,255,255,0.12)'; });
    closeBtn.addEventListener('mouseleave', function () { closeBtn.style.background = 'transparent'; });
    closeBtn.addEventListener('click', function () { host.remove(); });
    bar.appendChild(title);
    bar.appendChild(closeBtn);

    // The real BASS UI.
    var frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('sidepanel.html?mode=float');
    setStyles(frame, { flex: '1 1 auto', width: '100%', border: 'none', background: '#08090f' });

    host.appendChild(bar);
    host.appendChild(frame);

    // Resize handles on every edge and corner (layered above the iframe). Each
    // carries a direction string built from n/s (top/bottom) and w/e (left/
    // right); the corner one (bottom-right) also shows a visible grip glyph.
    var EDGE = 7;        // hit area thickness for edges
    var CORNER = 15;     // hit area size for corners
    var HANDLES = [
      { dir: 'n',  css: { top: '0', left: '0', right: '0', height: EDGE + 'px', cursor: 'ns-resize' } },
      { dir: 's',  css: { bottom: '0', left: '0', right: '0', height: EDGE + 'px', cursor: 'ns-resize' } },
      { dir: 'w',  css: { left: '0', top: '0', bottom: '0', width: EDGE + 'px', cursor: 'ew-resize' } },
      { dir: 'e',  css: { right: '0', top: '0', bottom: '0', width: EDGE + 'px', cursor: 'ew-resize' } },
      { dir: 'nw', css: { top: '0', left: '0', width: CORNER + 'px', height: CORNER + 'px', cursor: 'nwse-resize' } },
      { dir: 'ne', css: { top: '0', right: '0', width: CORNER + 'px', height: CORNER + 'px', cursor: 'nesw-resize' } },
      { dir: 'sw', css: { bottom: '0', left: '0', width: CORNER + 'px', height: CORNER + 'px', cursor: 'nesw-resize' } },
      { dir: 'se', css: { bottom: '0', right: '0', width: CORNER + 'px', height: CORNER + 'px', cursor: 'nwse-resize' } }
    ];

    var resizing = false, rDir = '', rw = 0, rh = 0, rl = 0, rt = 0, rx = 0, ry = 0;
    HANDLES.forEach(function (h) {
      var el = document.createElement('div');
      var base = { position: 'absolute', zIndex: '3' };
      for (var k in h.css) { if (Object.prototype.hasOwnProperty.call(h.css, k)) base[k] = h.css[k]; }
      setStyles(el, base);
      if (h.dir === 'se') {
        el.innerHTML =
          '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" ' +
          'style="display:block;position:absolute;right:1px;bottom:1px;pointer-events:none">' +
          '<path d="M11 15L15 11M6 15L15 6" stroke="rgba(255,255,255,0.45)" ' +
          'stroke-width="1.4" stroke-linecap="round"/></svg>';
      }
      el.addEventListener('mousedown', function (e) {
        resizing = true; rDir = h.dir;
        rw = host.offsetWidth; rh = host.offsetHeight;
        rl = host.offsetLeft;  rt = host.offsetTop;
        rx = e.clientX; ry = e.clientY;
        frame.style.pointerEvents = 'none';
        e.preventDefault(); e.stopPropagation();
      });
      host.appendChild(el);
    });

    document.documentElement.appendChild(host);

    var dragging = false, dx = 0, dy = 0;
    bar.addEventListener('mousedown', function (e) {
      if (e.target === closeBtn) return;
      dragging = true;
      dx = e.clientX - host.offsetLeft;
      dy = e.clientY - host.offsetTop;
      frame.style.pointerEvents = 'none';
      e.preventDefault();
    });

    function onMove(e) {
      if (dragging) {
        var nl = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 60));
        var nt = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 40));
        host.style.left = nl + 'px';
        host.style.top = nt + 'px';
      } else if (resizing) {
        var ddx = e.clientX - rx, ddy = e.clientY - ry;
        var vw = window.innerWidth, vh = window.innerHeight;
        // East / South grow with the pointer; West / North move the opposite
        // edge while keeping the anchored edge fixed.
        if (rDir.indexOf('e') >= 0) {
          host.style.width = Math.max(MIN_W, Math.min(rw + ddx, vw - rl)) + 'px';
        }
        if (rDir.indexOf('s') >= 0) {
          host.style.height = Math.max(MIN_H, Math.min(rh + ddy, vh - rt)) + 'px';
        }
        if (rDir.indexOf('w') >= 0) {
          var nw = Math.max(MIN_W, Math.min(rw - ddx, rl + rw));
          host.style.width = nw + 'px';
          host.style.left = (rl + rw - nw) + 'px';
        }
        if (rDir.indexOf('n') >= 0) {
          var nh = Math.max(MIN_H, Math.min(rh - ddy, rt + rh));
          host.style.height = nh + 'px';
          host.style.top = (rt + rh - nh) + 'px';
        }
      }
    }
    function onUp() {
      if (dragging || resizing) {
        frame.style.pointerEvents = '';
        saveBounds({
          width: host.offsetWidth, height: host.offsetHeight,
          left: host.offsetLeft, top: host.offsetTop
        });
      }
      dragging = false; resizing = false; rDir = '';
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }
})();
