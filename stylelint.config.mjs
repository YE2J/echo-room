/** @type {import('stylelint').Config} */
export default {
  extends: 'stylelint-config-standard',
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['tailwind', 'apply', 'layer', 'theme', 'custom-variant'],
      },
    ],
    'color-hex-length': null,
    'hue-degree-notation': null,
    'import-notation': null,
    'lightness-notation': null,
    'rule-empty-line-before': null,
    'value-keyword-case': null,
    // 项目广泛使用 BEM 修饰类（如 btn--ghost、msg--self），双横线不在默认 kebab-case 正则内
    'selector-class-pattern': null,
    // 组件的章节化书写顺序天然存在"高特异性 hover 在前、章节内选择器在后"的级联，无实际覆盖冲突
    'no-descending-specificity': null,
  },
};
