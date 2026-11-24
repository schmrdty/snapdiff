// Collapsible cards for the dashboard (src/server.ts, `sec` and the Nodes groups). Loaded from
// /static because the Caddy CSP allows script files from this origin ('self') and pins the one
// inline script by hash; nothing here is inline. Ryan approved the design on 2026-11-24.
//
// Runs twice:
// 1. In <head>, before the body exists: marks the page as scripted (the arrows appear) and hides
//    the cards the reader folded last time, so the 30 s reload never flashes them open.
// 2. On DOMContentLoaded: wires the arrows, the Chart / Numbers switch, and the links.
// State lives in localStorage per tab (mainnet or testnet) and per card id. Nothing leaves the
// browser.
(function () {
  var view = /[?&]net=testnet(&|$)/.test(location.search) ? "testnet" : "mainnet";
  var KEY = "snapdiff.fold." + view + ".";
  var VIEW_KEY = "snapdiff.causesView";
  var SAFE = /^[A-Za-z0-9_.-]+$/;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  document.documentElement.classList.add("fold-js");
  var shut = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(KEY) === 0 && localStorage.getItem(k) === "1" && SAFE.test(k.slice(KEY.length))) shut.push(k.slice(KEY.length));
    }
  } catch (e) {}
  var css = shut.map(function (id) { return '[id="' + id + '"]>.sec-body{display:none}'; }).join("");
  if (get(VIEW_KEY) === "chart") css += "#causes .stats{display:none}#causes .cchart{display:grid;gap:8px}";
  var boot = document.createElement("style");
  boot.textContent = css + ".sec-body,.fold svg{transition:none!important}";
  document.head.appendChild(boot);

  document.addEventListener("DOMContentLoaded", function () {
    var boxes = [].slice.call(document.querySelectorAll(".fold-box[id]"));
    function btnOf(box) { return box.firstElementChild && box.firstElementChild.querySelector(".fold"); }
    function setShut(box, isShut, save) {
      var b = btnOf(box);
      if (!isShut) {
        // Clip the body while it opens; the causes card lets its tooltips overflow once settled.
        box.classList.add("moving");
        setTimeout(function () { box.classList.remove("moving"); }, 260);
      }
      box.classList.toggle("shut", isShut);
      if (b) {
        b.setAttribute("aria-expanded", String(!isShut));
        b.setAttribute("aria-label", (isShut ? "Expand " : "Collapse ") + (box.getAttribute("data-name") || box.id));
      }
      if (save) put(KEY + box.id, isShut ? "1" : null);
    }
    boxes.forEach(function (box) {
      if (get(KEY + box.id) === "1") setShut(box, true, false);
      var b = btnOf(box);
      if (b) b.addEventListener("click", function () { setShut(box, !box.classList.contains("shut"), true); });
    });

    // Chart / Numbers on the causes card.
    var causes = document.getElementById("causes");
    var vt = causes && causes.querySelector(".vt");
    function setChart(on, save) {
      if (!causes || !vt) return;
      causes.classList.toggle("chart", on);
      vt.textContent = on ? "Numbers" : "Chart";
      vt.setAttribute("aria-pressed", String(on));
      if (save) put(VIEW_KEY, on ? "chart" : null);
    }
    if (vt) {
      setChart(get(VIEW_KEY) === "chart", false);
      vt.addEventListener("click", function () {
        setChart(!causes.classList.contains("chart"), true);
        if (causes.classList.contains("shut")) setShut(causes, false, true);
      });
    }

    // A jump link, an index row, or "all nodes" pointing into a folded card opens every card
    // around the target first.
    function openFor(hash) {
      if (!hash || hash.length < 2) return;
      var el = document.getElementById(decodeURIComponent(hash.slice(1)));
      for (var p = el; p; p = p.parentElement) if (p.classList && p.classList.contains("fold-box") && p.classList.contains("shut") && p !== el) setShut(p, false, true);
      if (el && el.classList.contains("fold-box") && el.classList.contains("shut")) setShut(el, false, true);
    }
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (a) openFor(a.getAttribute("href"));
    });
    addEventListener("hashchange", function () { openFor(location.hash); });
    openFor(location.hash);

    // Classes now carry the state; drop the boot rules after the first frame so later folds animate.
    requestAnimationFrame(function () { requestAnimationFrame(function () { boot.remove(); }); });
  });
})();
