import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

test("modal surfaces expose dialog semantics and shared keyboard focus containment", async () => {
  const [hook, app, office, kanban, chat] = await Promise.all([
    source("useModalFocus.js"),
    source("App.jsx"),
    source("HermesOffice.jsx"),
    source("HermesKanban.jsx"),
    source("ProfileChat.jsx"),
  ]);

  assert.match(hook, /event\.key === "Escape"/);
  assert.match(hook, /event\.key !== "Tab"/);
  assert.match(hook, /previousFocus\.focus/);
  assert.match(app, /role=\{mobileNav \? "dialog"/);
  assert.match(app, /aria-modal=\{mobileNav \? "true"/);
  assert.match(app, /className="sidebar-close"/);
  assert.equal((office.match(/role="dialog"/g) ?? []).length >= 3, true);
  assert.equal((kanban.match(/role="dialog"/g) ?? []).length >= 2, true);
  assert.equal((chat.match(/role="dialog"/g) ?? []).length >= 2, true);
  assert.match(chat, /name="chat-files" aria-label="파일 첨부"/);
  assert.match(chat, /name="chat-message" aria-label=\{`\$\{meta\.name\}에게 메시지 보내기`\}/);
});

test("mobile controls and terminal metrics retain touch and responsive contracts", async () => {
  const [styles, terminal] = await Promise.all([
    source("styles.css"),
    source("HermesTerminal.jsx"),
  ]);

  assert.match(styles, /\.menu-button \{[^}]*min-width: 44px;[^}]*min-height: 44px;/s);
  assert.match(styles, /\.sidebar\.open \.sidebar-close \{[^}]*width: 44px;[^}]*height: 44px;/s);
  assert.match(terminal, /if \(width < 420\) return 9;/);
  assert.match(terminal, /window\.visualViewport\?\.addEventListener\("resize", scheduleFit\)/);
  assert.match(terminal, /settleFrame = window\.requestAnimationFrame\(\(\) => \{/);
  assert.match(terminal, /RESIZE:\$\{terminal\.cols\};\$\{terminal\.rows\}/);
});
