export function buildCompileTodayPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-today.v1",
    cacheGroup: "memory.compile.today",
    systemPrompt: isZh
      ? `请把今天的对话摘要整理成一份"用户近况与大主题清单"。

提炼原则：
- 把同一主题/项目的多次往返归并为一件事，不要逐条流水账
- 时间标注用主时段（"上午/傍晚"或粗略 HH:MM 区间），不需精确到分钟
- 记忆的核心职责是维护用户模型，优先记录用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只允许保留到大主题层级：只写用户最近关注的领域/项目/主题，不写该主题里的细节

可以记录：
- 用户的身份、人格特质、审美、兴趣、喜欢或讨厌的事物
- 用户最近关注的大主题，例如"记忆系统""Project Hana""AI Agent"
- 用户生活、创作、关系或长期关注方向的变化

不要记录：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 任务过程中的方法论选择、工具偏好、格式要求、术语规则
- 具体子问题、具体方案、具体改法、具体测试或发布流程
- 助手具体产出的内容（"生成了一篇关于 X 的文章"够了，不要摘录文章内容）
- 来回修改、重试、被打断又恢复这类过程波动

输出 3-5 条粗颗粒事件，每条 1-2 句。最多 300 字。一天平淡就写得短。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Distill today's conversation summaries into a "user-current-state and broad-theme list".

Principles:
- Merge multiple back-and-forth on the same topic/project into ONE event; do not enumerate line by line
- Time markers use major periods ("morning/evening" or rough HH:MM range), no minute-level precision
- Memory's core job is to maintain a user model: prioritize who the user is, what they like, what they care about, and what they are broadly focused on recently
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme

May record:
- The user's identity, personality traits, aesthetics, interests, likes, and dislikes
- Broad themes the user is currently focused on, such as "memory systems", "Project Hana", or "AI Agent"
- Changes in the user's life, creative work, relationships, or long-term areas of attention

Do NOT record:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Task-level methodology choices, tool preferences, format requirements, terminology rules
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Specific content of assistant's output ("wrote an article about X" is enough; do not excerpt the article)
- Revisions, retries, interruptions and resumptions — these are process noise

Output 3-5 coarse events, 1-2 sentences each. Max 180 words. Keep it short on quiet days. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
  };
}

export function buildCompileWeekPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-week.v1",
    cacheGroup: "memory.compile.week",
    systemPrompt: isZh
      ? `请把过去 7 天的对话摘要整理成一份"本周用户主题概要"。

关键定位：到 week 这一层，记录已经是粗线条的了。它不是"每天发生的事"的集合，而是再上一层——归纳用户这一周大致在关注什么、投入什么、发生了什么重要变化。读这份记录的人只需要知道用户近况和大主题，不需要知道任何过程细节。

提炼层级：
- 记忆的核心职责是维护用户模型：用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只允许保留到大主题层级：只写用户最近关注的领域/项目/主题，不写该主题里的细节
- 持续性的关注主题（"本周持续关注 X"、"这几天主要在做 Y"）放最前
- 够分量的个人近况、创作主题、关系变化、兴趣变化次之
- 时间用模糊表述（"周初/前几天/这两天"），不留精确时间戳

明确不要保留的内容：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 某个主题里的具体子问题、具体方案、具体改法、具体测试或发布流程
- 任务过程中的方法论、工具、格式选择
- 单次对话内的来回修改、临时决定
- 助手的具体产出内容
- 不重要的杂事（普通的闲聊、查询、调试）

只记录"用户这一周大致关注什么、发生了什么重要变化"。工作只记大主题，其他可以不写。

输出 3-5 条本周主题/事件。最多 400 字。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Distill the past 7 days' conversation summaries into a "weekly user-theme overview".

Positioning: at the week layer, the record is already coarse-grained. It is NOT a collection of "what happened each day" — it is one level above: distilling what the user was broadly focused on, invested in, and what important changes happened. The reader only needs user current-state and broad themes, not any process detail.

Layering:
- Memory's core job is to maintain a user model: who the user is, what they like, what they care about, and what they are broadly focused on recently
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme
- Persistent focus themes ("focused on X this week", "spent several days on Y") come first
- Substantial personal current-state, creative themes, relationship changes, or interest changes come second
- Time is vague ("early in the week / a few days ago / these last two days"); do NOT preserve exact timestamps

Explicitly do NOT keep:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Task-level details (how it was done, how many revisions, interruptions and resumptions)
- Task-level methodology, tools, format choices
- Within-conversation revisions and temporary decisions
- Specific content of assistant's output
- Trivial activity (small talk, lookups, debugging)

Record only "what the user was broadly focused on and what important changes happened this week". For work, keep only the broad theme. Skip the rest.

Output 3-5 weekly themes/events. Max 240 words. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
  };
}

export function buildCompileLongtermPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-longterm.v1",
    cacheGroup: "memory.compile.longterm",
    systemPrompt: isZh
      ? `请综合「上一份长期情况」和「本周新增」，重写成一份新的长期情况。必须控制在 400 字以内。

记忆不是工作日志，也不是协作手册。到 longterm 这一层，记录已经是最稳定的用户画像核心。只保留"如果一年后回看仍然适合用来理解用户这个人"的内容：
- 用户的身份、人格特质、审美、兴趣、价值取向
- 用户长期喜欢或讨厌的事物
- 用户长期关系和稳定生活背景
- 用户持续关注或投入的长期关注方向

去掉这些"单次性内容"：
- 某天/某周完成的具体任务
- 用户偏好的工作方式、协作流程、工程纪律
- 工具使用习惯、检查顺序、汇报格式
- 某类任务的处理方法
- 助手的具体产出内容
- 任何"这周/那周"级别的细节

处理方式：
- 不要追加，不要把旧内容和新内容分开复述
- 必须做取舍、抽象、合并，把重复或过细的信息压成更高层概括
- 如果上一份长期情况已经很长，优先概括旧内容，再吸收真正重要的新内容

不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Synthesize "Previous long-term context" and "This week's additions", then rewrite them into one new long-term context. You must keep the result under 240 words.

Memory is not a work log or collaboration manual. At the longterm layer, the record is the most stable user-profile core. Keep only what would still help understand the user as a person "if reviewed a year from now":
- The user's identity, personality traits, aesthetics, interests, and values
- Things the user has long liked or disliked
- Long-term relationships and stable life background
- Persistent long-term focus directions

Remove these "one-off" contents:
- Specific tasks completed on a particular day or week
- User-preferred work style, collaboration process, or engineering discipline
- Tool habits, validation order, report format
- How to handle a class of task
- Specific content of assistant's output
- Any "this week / that week" level details

How to process:
- Do not append; do not restate old and new content separately
- Make tradeoffs, abstract, and merge; compress repeated or overly specific details into higher-level facts
- If the previous long-term context is already long, summarize it first, then absorb only genuinely important new content

Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
  };
}

export function buildCompileFactsPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-facts.v1",
    cacheGroup: "memory.compile.facts",
    systemPrompt: isZh
      ? "请综合「现有 Facts」和「新增候选 Facts」，重写成一份新的重要事实。必须控制在 200 字以内，宁可概括合并，也不要堆叠罗列。现有 Facts 是基础，但如果过长，必须压成更高层概括；新增候选 Facts 只在能纠正、补充或更新稳定用户画像时吸收。只保留稳定的、跨时间有效的用户画像：身份、人格特质、审美、兴趣、喜欢或讨厌的事物、长期关系、长期关注方向。矛盾时以新增候选 Facts 为准。不要追加，不要把两部分分别复述。不要保留工作方式、协作流程、工具偏好、执行细节。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。"
      : "Synthesize \"Existing Facts\" and \"New Candidate Facts\", then rewrite them into one new Key Facts section. You must keep the result under 120 words; prefer concise abstraction and merging over stacked lists. Existing Facts are the base, but if they are too long, compress them into higher-level facts. Absorb New Candidate Facts only when they correct, supplement, or update stable user-profile information. Keep only stable, time-persistent user-profile facts: identity, personality traits, aesthetics, interests, likes/dislikes, long-term relationships, and long-term focus directions. When facts conflict, prefer New Candidate Facts. Do not append. Do not restate the two inputs separately. Do not keep work style, collaboration process, tool preferences, or execution details. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.",
  };
}

export function buildCompileEditableFactsPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-editable-facts.v1",
    cacheGroup: "memory.compile.editable_facts",
    systemPrompt: isZh
      ? "请综合「当前可信 Facts」和「新增候选 Facts」，重写成一份新的重要事实。必须控制在 200 字以内，宁可概括合并，也不要堆叠罗列。当前可信 Facts 代表用户或 Agent 已确认过的稳定信息，默认作为基础，但如果过长，必须压成更高层概括；新增候选 Facts 只在能纠正、补充或更新稳定用户画像时吸收。只保留稳定的、跨时间有效的用户画像：身份、人格特质、审美、兴趣、喜欢或讨厌的事物、长期关系、长期关注方向。新增候选 Facts 与当前可信 Facts 冲突时，以新增候选 Facts 修正当前事实。不要追加，不要把两部分分别复述。不要保留工作方式、协作流程、工具偏好、执行细节。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。"
      : "Synthesize \"Current Trusted Facts\" and \"New Candidate Facts\", then rewrite them into one new Key Facts section. You must keep the result under 120 words; prefer concise abstraction and merging over stacked lists. Current Trusted Facts are stable information confirmed by the user or agent and are the base, but if they are too long, compress them into higher-level facts. Absorb New Candidate Facts only when they correct, supplement, or update stable user-profile information. Keep only stable, time-persistent user-profile facts: identity, personality traits, aesthetics, interests, likes/dislikes, long-term relationships, and long-term focus directions. When New Candidate Facts conflict with Current Trusted Facts, use them to correct the current facts. Do not append. Do not restate the two inputs separately. Do not keep work style, collaboration process, tool preferences, or execution details. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.",
  };
}
