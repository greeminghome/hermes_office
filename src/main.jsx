import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./organizationB1.css";
import "./officeMap.css";
import "./systemPro.css";
import App from "./App.jsx";
import { migrateNamespacedStorage } from "./storageMigration.js";

registerSW({ immediate: true });
migrateNamespacedStorage();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
