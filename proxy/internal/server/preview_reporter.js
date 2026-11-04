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

  function reload() {
    if (!postedDocument) return location.reload();
    location.replace(location.hash ? location.href.slice(0, -location.hash.length) : location.href);
  }

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
