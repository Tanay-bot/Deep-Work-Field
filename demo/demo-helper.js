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
    // Land with the verified heading at the top and the answer box below it.
    var top = host.getBoundingClientRect().top + window.scrollY - 28;
    window.scrollTo({ top: Math.max(0, top) });
    try { field.focus({ preventScroll: true }); } catch (e) { field.focus(); }
    return true;
  };

  window.DWF_VERIFIED = function (label, problemId) {
    var host = problemId ? problem(problemId) : null;
    document.querySelectorAll('.dwf-landed').forEach(function (el) { el.classList.remove('dwf-landed'); });
    document.querySelectorAll('.dwf-marker').forEach(function (el) { el.remove(); });
    var heading = host ? host.querySelector('h3') : null;
    if (heading) {
      host.classList.add('dwf-landed');
      var marker = document.createElement('span');
      marker.className = 'dwf-marker';
      marker.setAttribute('role', 'status');
      marker.textContent = label || 'Verified';
      heading.appendChild(marker);
      return;
    }
    var pill = document.getElementById('restored-pill');
    if (!pill) return;
    pill.textContent = label || 'Deep Work Field verified this passage.';
    pill.style.display = 'block';
    setTimeout(function () { pill.style.display = 'none'; }, 6000);
  };

  [['capture-4b', '4b'], ['capture-2a', '2a']].forEach(function (pair) {
    var button = document.getElementById(pair[0]);
    if (!button) return;
    button.addEventListener('click', function () {
      var cap = window.DWF_CAPTURE(pair[1]);
      if (cap) send({ type: 'dwf-capture', problemId: pair[1] });
    });
  });

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
