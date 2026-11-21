/* Demo-only helper. Loaded by the bundled worksheets, works offline. */
(function () {
  var channel = null;
  try {
    channel = new BroadcastChannel('dwf-demo');
  } catch (err) {
    channel = null;
  }

  function send(payload) {
    var message = Object.assign({ source: 'dwf-demo-worksheet' }, payload);
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage(message, '*');
    } catch (err) { /* opener gone */ }
    if (channel) channel.postMessage(message);
  }

  function problem(id) {
    return document.querySelector('[data-problem-id="' + id + '"]');
  }

  window.DWF_CAPTURE = function (id) {
    var host = problem(id);
    if (!host) return null;
    var heading = host.querySelector('[data-anchor-text]') || host.querySelector('h3,h2,h4');
    if (!heading) return null;
    heading.scrollIntoView({ block: 'center' });
    return { heading: heading, host: host, problemId: id };
  };

  window.DWF_FOCUS_ANSWER = function (id) {
    var host = problem(id);
    if (!host) return false;
    var field = host.querySelector('textarea,input');
    if (!field) return false;
    field.focus();
    field.scrollIntoView({ block: 'center' });
    return true;
  };

  window.DWF_VERIFIED = function (label) {
    var pill = document.getElementById('restored-pill');
    if (!pill) return;
    pill.textContent = label || 'Deep Work Field verified this passage.';
    pill.style.display = 'block';
    setTimeout(function () { pill.style.display = 'none'; }, 6000);
  };

  var button = document.getElementById('capture-4b');
  if (button) {
    button.addEventListener('click', function () {
      var cap = window.DWF_CAPTURE('4b');
      if (cap) send({ type: 'dwf-capture', problemId: '4b' });
    });
  }

  document.querySelectorAll('[data-answer-region]').forEach(function (region) {
    var field = region.querySelector('textarea,input');
    if (!field) return;
    field.addEventListener('input', function () {
      var value = field.value;
      var newline = value.indexOf('\n') !== -1;
      send({
        type: 'dwf-edit',
        problemId: region.getAttribute('data-problem-id'),
        chars: value.length,
        newline: newline,
        qualifies: value.length >= 10 || newline
      });
    });
  });

  send({ type: 'dwf-ready' });
})();
