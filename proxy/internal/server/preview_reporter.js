(function () {
  var platformOrigin = PLATFORM_ORIGIN;
  var postedDocument = POSTED_DOCUMENT;
  if (window.parent === window || window.__opsiforcePreviewReporter) return;
  window.__opsiforcePreviewReporter = true;
  var navigation = window.navigation;

  function report() {
    window.parent.postMessage(
      {
        type: 'opsiforce-preview:location',
        href: location.href,
        canGoBack: Boolean(navigation && navigation.canGoBack),
        canGoForward: Boolean(navigation && navigation.canGoForward),
      },
      platformOrigin
    );
  }

  var HASH_KEY = 'opsiforce-preview:hash';

  function reload() {
    if (!postedDocument) return location.reload();
    var hash = location.hash;
    var address = hash ? location.href.slice(0, -hash.length) : location.href;
    try {
      if (hash) sessionStorage.setItem(HASH_KEY, JSON.stringify({ address: address, hash: hash }));
    } catch (error) {}
    location.replace(address);
  }

  function restoreHash() {
    var saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(HASH_KEY));
      sessionStorage.removeItem(HASH_KEY);
    } catch (error) {
      return;
    }
    if (!saved || saved.address !== location.href) return;
    history.replaceState(history.state, '', saved.address + saved.hash);
    window.addEventListener('load', function () {
      try {
        var target = document.getElementById(decodeURIComponent(saved.hash.slice(1)));
        if (target) target.scrollIntoView();
      } catch (error) {}
    });
  }

  restoreHash();

  function traverse(direction) {
    if (!navigation || !(direction === 'back' ? navigation.canGoBack : navigation.canGoForward)) return;
    var result = navigation[direction]();
    result.committed.catch(function () {});
    result.finished.catch(function () {});
  }

  if (navigation) {
    navigation.addEventListener('currententrychange', report);
  } else {
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        report();
        return result;
      };
    });
    window.addEventListener('popstate', report);
    window.addEventListener('hashchange', report);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== platformOrigin || !event.data) return;
    if (['opsiforce-preview:reload', 'opsiforce-preview:back', 'opsiforce-preview:forward'].indexOf(event.data.type) === -1) return;
    window.parent.postMessage({ type: 'opsiforce-preview:acknowledged' }, platformOrigin);
    if (event.data.type === 'opsiforce-preview:reload') reload();
    if (event.data.type === 'opsiforce-preview:back') traverse('back');
    if (event.data.type === 'opsiforce-preview:forward') traverse('forward');
  });

  report();
})();
