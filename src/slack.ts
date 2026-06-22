import type { Summary } from "./summary.js";
import type { Task } from "./types.js";

function bullet(t: Task): string {
  const due = t.dueDate ? ` _(期限: ${t.dueDate})_` : "";
  const link = t.url ? `<${t.url}|${t.title}>` : t.title;
  return `• ${link}${due}`;
}

function section(title: string, tasks: Task[], max = 8): string | null {
  if (tasks.length === 0) return null;
  const lines = tasks.slice(0, max).map(bullet);
  if (tasks.length > max) lines.push(`…他 ${tasks.length - max}件`);
  return `*${title}* (${tasks.length})\n${lines.join("\n")}`;
}

/** SlackのBlock Kit形式でサマリを組み立てる */
export function buildSlackPayload(
  s: Summary,
  completed: Task[] = [],
  sinceLabel = "",
): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📋 タスクサマリ（残 ${s.total}件）` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `進行中 *${s.inProgress.length}* / 未デプロイ *${s.undeployed.length}* / 未着手 *${s.inbox.length}*`,
        },
      ],
    },
  ];

  // 前営業日以降に完了したタスク（良い知らせを先に）
  const completedSection = section(
    `✅ ${sinceLabel}以降に完了`,
    completed,
    10,
  );
  if (completedSection) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: completedSection } });
  }

  const sections = [
    section("🔴 期限超過", s.overdue),
    section("🟡 期限間近（3日以内）", s.dueSoon),
    section("🚀 未デプロイ", s.undeployed),
    section("🔵 進行中", s.inProgress),
    section("📥 未着手", s.inbox, 10),
  ].filter((x): x is string => x !== null);

  for (const text of sections) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
  }

  if (s.total === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "🎉 残タスクはありません。" },
    });
  }

  return { blocks };
}

/** Slack Incoming Webhookへ送信する */
export async function sendToSlack(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack送信に失敗しました: ${res.status} ${body}`);
  }
}
