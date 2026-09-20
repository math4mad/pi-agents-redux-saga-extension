# Pi Agent Control Room

一个仪表盘：你只跟**内勤**说话，内勤把活派给**外勤**，改动性的活要你签字才开工。

- **先看效果（不花 token，不需要 pi）**：`GETTING-STARTED.md` 第 1 节 —— `npm ci && npm run demo` + `npm run dev`
- **换机器 / 装环境 / WiFi 局域网访问**：`GETTING-STARTED.md`
- **排障、编制与闸门的全部细节**：`TESTING-ON-ANOTHER-MAC.md`

```bash
npm run demo   # 终端 A：假桥，脚本回放
npm run dev    # 终端 B：http://127.0.0.1:5173/
```

---

<details>
<summary>原始 Vite 模板说明</summary>

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

</details>
