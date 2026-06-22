export function optimizeCodingPrompt(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.includes('目标：') && raw.includes('约束：') && raw.includes('验收：')) {
    return raw;
  }
  return [
    '请作为 HanaIDE 编程助手处理下面的开发任务。',
    '',
    `目标：${raw}`,
    '',
    '上下文：先阅读相关代码和现有模式，再决定实现位置；优先复用项目内已有工具、状态和组件。',
    '',
    '约束：',
    '- 保持改动聚焦，不做无关重构。',
    '- 涉及 UI 时保持当前主题和布局一致，避免遮挡、溢出和假按钮。',
    '- 涉及后端或文件操作时保留安全边界，错误要可诊断。',
    '- 新行为需要补充或更新测试。',
    '',
    '验收：',
    '- 说明修改的关键文件。',
    '- 给出实际运行过的测试或构建命令。',
    '- 如果有未完成项，明确剩余风险。',
  ].join('\n');
}
