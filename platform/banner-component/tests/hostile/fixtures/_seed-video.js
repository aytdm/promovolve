// Seeds a creative whose COVER is a video background, for the anti-blink
// probe in run.mjs. Separate from _seed.js because the assertions differ:
// the other fixtures ask "does the ad survive this page", this one asks
// "does the ad ever paint a flat colour where the film should be".
//
// The clip URL carries ?stall=<ms>, which the runner's server honours by
// holding the response — a decoded-instantly clip cannot reproduce the
// gap this fixture exists to police. Poster on/off comes from the page's
// own query string so one fixture covers both paths:
//   ?poster=1 → the box must open on the poster
//   (absent)  → no poster to paint, so the reveal must WAIT for the clip
//
// The cover's `bg` is a colour that must never reach the screen. If the
// probe ever sees it, the page painted its colour under the video and
// the blink is back.
(function () {
  var STALL_MS = 1200; // < the 2s reveal cap, so the gate resolves normally
  var withPoster = /(^|[?&])poster=1(&|$)/.test(location.search);
  var video = {
    src: "/tests/hostile/fixtures/_clip.mp4?stall=" + STALL_MS,
    fit: "cover",
  };
  if (withPoster) video.poster = "/tests/hostile/fixtures/_clip-poster.jpg";

  var PAGES = [
    { bg: "#ff00ff", videoBg: video, layout: [
      { type: "text", text: "VIDEO COVER", left: 8, top: 20, width: 84, fontSize: 12, color: "#fff", fontWeight: 800 },
    ]},
    { bg: "#2d132c", layout: [
      { type: "text", text: "Page 2", left: 8, top: 44, width: 84, fontSize: 11, color: "#fff", fontWeight: 700 },
    ]},
    { bg: "#0b3d2e", layout: [
      { type: "text", text: "Page 3", left: 8, top: 44, width: 84, fontSize: 11, color: "#fff", fontWeight: 700 },
    ]},
  ];
  function seed() {
    var slot = document.getElementById("slot");
    if (!slot) return;
    var el = document.createElement("expandable-magazine-banner");
    el.setAttribute("pages", JSON.stringify(PAGES));
    el.setAttribute("width", "300");
    el.setAttribute("height", "250");
    slot.appendChild(el);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", seed);
  else seed();
})();
