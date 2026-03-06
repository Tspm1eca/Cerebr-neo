/**
 * 從 prompts.json 生成 src/constants/prompts.js
 * Usage: node scripts/generate-prompts.js
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const inputPath = path.join(rootDir, 'prompts.json');
const outputPath = path.join(rootDir, 'src', 'constants', 'prompts.js');

const prompts = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

const lines = [
    '// Auto-generated from prompts.json — DO NOT EDIT MANUALLY',
    '// Run: node scripts/generate-prompts.js',
    '',
];

// 按照原始順序輸出所有欄位
for (const [key, value] of Object.entries(prompts)) {
    if (key === 'version') continue;

    if (Array.isArray(value)) {
        // 陣列常量（如 DEFAULT_QUICK_CHAT_OPTIONS）
        lines.push(`export const ${key} = ${JSON.stringify(value, null, 4)};`);
    } else if (typeof value === 'string') {
        lines.push(`export const ${key} = ${JSON.stringify(value)};`);
    }
    lines.push('');
}

// 輔助函數
lines.push('export function createDefaultQuickChatOptions() {');
lines.push('    return DEFAULT_QUICK_CHAT_OPTIONS.map((option) => ({ ...option }));');
lines.push('}');
lines.push('');

fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
console.log('Generated src/constants/prompts.js from prompts.json');
