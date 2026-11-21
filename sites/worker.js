export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Workers Assets redirects /x.html to /x. The app and its service worker
    // expect the explicit .html paths (and offline precache fails on a 307),
    // so fetch the extensionless asset internally while keeping the URL.
    if (url.pathname.endsWith('.html')) {
      url.pathname = url.pathname.slice(0, -5) || '/';
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }
    return env.ASSETS.fetch(request);
  },
};
