// Progressive enhancement only. Every page renders completely without this file.
(() => {
  "use strict";
  document.documentElement.classList.add("js");

  // Copy button for the quickstart block (hidden until JS runs).
  for (const button of document.querySelectorAll(".copy-button[data-copy]")) {
    if (!navigator.clipboard) break;
    button.hidden = false;
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(button.dataset.copy ?? "").then(
        () => {
          const previous = button.textContent;
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.textContent = previous;
          }, 1600);
        },
        () => {
          /* Clipboard unavailable (permissions): leave the button as-is. */
        },
      );
    });
  }
})();
