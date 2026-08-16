/**
 * 📱 iOS COMPATIBILITY SHIM
 *
 * The runtime half of the iOS layer; ios-compat.css is the declarative
 * half. Everything here is either a no-op or a strict improvement on a
 * desktop browser, so it is safe to load unconditionally on every page.
 *
 * Load it with `defer` after the page's own scripts. It re-scans on
 * resize, on rotation and whenever the page rewrites its DOM, because
 * almost every tool in the hub renders its tables from JavaScript long
 * after DOMContentLoaded.
 */
(function () {
    'use strict';

    var root = document.documentElement;

    // iPadOS reports itself as a Mac, so the touch check is what actually
    // separates it from a desktop Safari.
    var IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var IS_TOUCH = window.matchMedia('(hover: none)').matches;
    var SMALL_BP = 820;
    var PHONE_BP = 560;

    root.classList.add(IS_IOS ? 'is-ios' : 'not-ios');
    if (IS_TOUCH) root.classList.add('is-touch');
    if (window.navigator.standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches) {
        root.classList.add('is-standalone');
    }

    /* ============================================================== *
     * 1. Viewport height
     * ============================================================== *
     * `100vh` on iOS means "the height the page would have with the
     * address bar collapsed", so a 100vh app shell is always taller than
     * the screen and its bottom row hides behind the bar. Pages use
     * var(--app-h) instead; the CSS resolves that to 100dvh where it
     * exists and this fills it in for iOS 15.3 and earlier.
     *
     * innerHeight, not visualViewport.height: the latter shrinks when the
     * keyboard opens, which would collapse the layout mid-edit.
     */
    var needsHeightShim = !(window.CSS && CSS.supports && CSS.supports('height', '100dvh'));

    function syncHeight() {
        root.style.setProperty('--app-h', window.innerHeight + 'px');
    }

    if (needsHeightShim) {
        syncHeight();
        window.addEventListener('resize', syncHeight);
        window.addEventListener('orientationchange', function () {
            // The new dimensions are not readable until after the rotation
            // settles.
            setTimeout(syncHeight, 250);
        });
    }

    /* ============================================================== *
     * 2. Wide content scrolls on its own
     * ============================================================== *
     * One table wider than the screen makes the entire document scroll
     * sideways, which drags every other section off-centre and leaves the
     * sticky header floating over open space. Giving the offending
     * element its own horizontal scroller keeps the page itself the width
     * of the screen.
     */
    var WRAP_SELECTOR = 'table, canvas, svg, .ios-scroll-me';

    function columnCount(table) {
        var row = (table.tHead && table.tHead.rows[0]) || table.rows[0];
        if (!row) return 0;
        var n = 0;
        for (var i = 0; i < row.cells.length; i++) n += row.cells[i].colSpan || 1;
        return n;
    }

    /*
     * Is this element already sitting in a scroller of its own?
     *
     * Only the two nearest ancestors count, and that is deliberate. A page
     * shell whose <main> is `overflow-y: auto` computes to
     * `overflow-x: auto` as well - the spec forces the other axis off
     * `visible` - so walking the full ancestor chain would decide that
     * every table on the page was already handled, when in fact the whole
     * content column would be dragged sideways to read one of them.
     */
    function isAlreadyScrolled(el) {
        var p = el.parentElement;
        for (var depth = 0; p && p !== document.body && depth < 2; depth++, p = p.parentElement) {
            if (p.classList.contains('ios-scroll-x')) return true;
            var ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
        }
        return false;
    }

    // <svg> is not an HTMLElement, so it has neither offsetWidth nor
    // scrollWidth - the box has to come off the rect.
    function renderedWidth(el) {
        return Math.max(el.scrollWidth || 0, el.offsetWidth || 0,
            el.getBoundingClientRect().width);
    }

    function shouldWrap(el, avail) {
        if (!avail) return false; // hidden, or not laid out yet
        var width = renderedWidth(el);
        // Every page is full of inline icons; only real diagrams and
        // charts are worth a scroller.
        if (el.tagName !== 'TABLE' && width < 200) return false;
        if (el.tagName === 'TABLE') {
            // A `table-layout: fixed; width: 100%` table technically fits
            // the screen - it just squashes eight columns into 390px and
            // becomes unreadable. Those are wrapped on width alone so the
            // stylesheet can give them a legible minimum and let them
            // scroll. Phone-width screens cannot even carry three columns
            // once one of them holds a sentence.
            var maxCols = window.innerWidth <= PHONE_BP ? 3 : 4;
            if (window.innerWidth <= SMALL_BP && columnCount(el) >= maxCols) return true;
        }
        return width > avail + 1;
    }

    /*
     * A grid or flex item is `min-width: auto` by default, which means it
     * refuses to become narrower than its own min-content. One wide table
     * therefore does not overflow its own card - it widens the whole
     * track, then the card, then the page, and iOS answers by zooming the
     * entire document out until it fits. Letting the item shrink puts the
     * overflow back where it belongs: inside the table's own scroller.
     *
     * Deliberately phone-only. On a desktop the intrinsic minimum is what
     * keeps these layouts honest.
     */
    function relaxAncestorTracks(el) {
        for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            var parent = p.parentElement;
            if (!parent) break;
            if (p.hasAttribute('data-ios-relaxed')) continue;
            var display = getComputedStyle(parent).display;
            if (display.indexOf('flex') === -1 && display.indexOf('grid') === -1) continue;
            p.setAttribute('data-ios-relaxed', '');
            p.style.minWidth = '0';
        }
    }

    function wrapOverflowing() {
        var narrow = window.innerWidth <= SMALL_BP;
        var nodes = document.querySelectorAll(WRAP_SELECTOR);
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var parent = el.parentElement;
            if (!parent) continue;
            // Runs even for content the page already scrolls itself: the
            // ancestor tracks still have to be allowed to shrink around it.
            if (narrow && renderedWidth(el) > 0) relaxAncestorTracks(el);
            if (parent.classList.contains('ios-scroll-x')) {
                // Already wrapped - just keep the wide-table flag current,
                // since the column count can change as data loads.
                if (el.tagName === 'TABLE') {
                    el.classList.toggle('ios-wide-table', columnCount(el) >= 3);
                }
                continue;
            }
            if (el.closest('.ios-no-wrap')) continue;
            if (isAlreadyScrolled(el)) continue;
            if (!shouldWrap(el, parent.clientWidth)) continue;

            var wrap = document.createElement('div');
            wrap.className = 'ios-scroll-x';
            parent.insertBefore(wrap, el);
            wrap.appendChild(el);
            if (el.tagName === 'TABLE' && columnCount(el) >= 3) {
                el.classList.add('ios-wide-table');
            }
        }
    }

    /* ============================================================== *
     * 3. Hover-only menus
     * ============================================================== *
     * The hub's account menu is `hidden group-hover:block`. iOS has no
     * hover: the first tap latches :hover onto whatever was tapped and
     * the menu either never opens or refuses to close. Turn the wrapper
     * into a tap toggle instead, using delegation so it keeps working
     * across the nav re-renders that follow every auth state change.
     */
    var MENU_SELECTOR = '[class*="group-hover:block"], [class*="group-hover:flex"]';

    function closeMenus() {
        var open = document.querySelectorAll('.ios-menu-open');
        for (var i = 0; i < open.length; i++) open[i].classList.remove('ios-menu-open');
    }

    function onDocumentClick(e) {
        var group = e.target.closest ? e.target.closest('.group') : null;
        var menu = group && group.querySelector(MENU_SELECTOR);
        var wasOpen = group && group.classList.contains('ios-menu-open');
        closeMenus();
        // No menu here, or the tap landed on an item inside the open menu -
        // either way the menu should end up closed, and in the second case
        // the item's own handler still runs.
        if (!menu || menu.contains(e.target)) return;
        if (!wasOpen) group.classList.add('ios-menu-open');
    }

    function onMenuKey(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var group = e.target.closest && e.target.closest('[data-ios-menu]');
        if (!group || group !== e.target) return;
        e.preventDefault();
        var wasOpen = group.classList.contains('ios-menu-open');
        closeMenus();
        if (!wasOpen) group.classList.add('ios-menu-open');
    }

    // Only on touch: on a pointer device the CSS :hover rule still drives
    // these menus, and announcing a button that nothing toggles would be
    // worse than saying nothing.
    function markMenuTriggers() {
        if (!IS_TOUCH) return;
        var menus = document.querySelectorAll(MENU_SELECTOR);
        for (var i = 0; i < menus.length; i++) {
            var group = menus[i].parentElement;
            if (!group || !group.classList.contains('group')) continue;
            if (group.hasAttribute('data-ios-menu')) continue;
            group.setAttribute('data-ios-menu', '');
            group.setAttribute('role', 'button');
            group.setAttribute('tabindex', '0');
            group.setAttribute('aria-haspopup', 'true');
        }
    }

    /* ============================================================== *
     * 4. Keeping the focused field above the keyboard
     * ============================================================== *
     * Safari scrolls a focused field into view by scrolling the document.
     * Several tools here scroll an inner <main> instead, so the field
     * stays hidden behind the keyboard and the user types blind.
     */
    function keepFocusVisible(e) {
        var el = e.target;
        if (!el.matches || !el.matches('input, textarea, select, [contenteditable]')) return;
        // Wait for the keyboard animation to finish before measuring.
        setTimeout(function () {
            var vv = window.visualViewport;
            var box = el.getBoundingClientRect();
            var bottom = vv ? vv.height : window.innerHeight;
            if (box.bottom > bottom - 8 || box.top < 0) {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }, 350);
    }

    /* ============================================================== *
     * 5. Scheduling
     * ============================================================== */
    var observer = null;
    var pending = null;

    function rescan() {
        pending = null;
        if (observer) observer.disconnect();
        try {
            wrapOverflowing();
            markMenuTriggers();
        } finally {
            if (observer) {
                observer.observe(document.body, { childList: true, subtree: true });
            }
        }
    }

    function scheduleRescan() {
        if (pending) return;
        pending = setTimeout(rescan, 250);
    }

    function start() {
        if (!document.body) return;
        if (IS_TOUCH) {
            document.addEventListener('click', onDocumentClick, false);
            document.addEventListener('keydown', onMenuKey, false);
        }
        if (IS_IOS) document.addEventListener('focusin', keepFocusVisible, false);

        rescan();
        // Fonts and late-loading data both change how wide a table is.
        window.addEventListener('load', scheduleRescan);
        window.addEventListener('resize', scheduleRescan);
        window.addEventListener('orientationchange', function () {
            setTimeout(rescan, 300);
        });

        if (window.MutationObserver) {
            observer = new MutationObserver(scheduleRescan);
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
