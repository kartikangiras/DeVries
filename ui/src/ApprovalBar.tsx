import { useEffect, useState } from "react";
import { api, type DraftAnswer, type Mitigation } from "./api";
import { verdictLine } from "./desk";
import { WithNames, capital, plural } from "./text";
import { Button } from "./ui";

type Props = {
  mitigation: Mitigation;
  names: Record<string, string>;
  busy: boolean;
  scenario: string;
  /** Whether this machine may write a file at all (never on a public site). */
  canWrite: boolean;
  onApprove: (approver: string, write: { after: string | null } | null) => void;
  onReject: (approver: string, reason: string) => void;
};

const KIND_WORDS: Record<string, string> = {
  "claude-code": "Claude Code settings", "claude-desktop": "Claude Desktop config", cursor: "Cursor config", vscode: "VS Code config",
  "docker-mcp-gateway": "Docker MCP Gateway commands", scenario: "the scenario file", "tools-list": "a brief",
};

function DiffLines({ text }: { text: string }) {
  return (
    <pre className="draft-diff">
      {text.split("\n").map((line, i) => (
        <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}>
          {line}{"\n"}
        </span>
      ))}
    </pre>
  );
}

/**
 * Docked under the page while a plan waits for a person, and only then. Its button is the one thing
 * on the page no tool can do. Under the line it shows the plan as the change to the real configuration:
 * the diff, which the person can edit, and whether it will be written when they approve. The shape
 * follows Manthan's approval bar (see ui/THIRD_PARTY_NOTICES.md).
 */
export function ApprovalBar({ mitigation, names, busy, scenario, canWrite, onApprove, onReject }: Props) {
  const [approver, setApprover] = useState(() => localStorage.getItem("cistern.approver") ?? "");
  // Turning a plan down, and why, belong to that one plan. When another plan takes its place in the bar
  // the bar is back to its two buttons: a reason typed for one plan can never be sent with the next.
  const [refusal, setRefusal] = useState<{ id: string; reason: string } | null>(null);
  const [draft, setDraft] = useState<DraftAnswer | null>(null);
  const [showDraft, setShowDraft] = useState(false);
  const [editing, setEditing] = useState(false);
  const [after, setAfter] = useState("");
  // writing a file is a second decision, taken by ticking the box: Approve alone changes only the graph
  const [writeIt, setWriteIt] = useState(false);
  useEffect(() => {
    let wanted = true;
    setDraft(null);
    setEditing(false);
    api.draft(scenario, mitigation.id)
      .then((d) => { if (wanted) { setDraft(d); setAfter(d.draft.after); } })
      .catch(() => wanted && setDraft(null));
    return () => { wanted = false; };
  }, [scenario, mitigation.id]);

  const rejecting = refusal?.id === mitigation.id;
  const reason = rejecting ? refusal!.reason : "";
  const who = approver.trim() || "a visitor";
  const remember = () => localStorage.setItem("cistern.approver", approver.trim());
  const changes = mitigation.summary.length;
  const d = draft?.draft ?? null;
  const can = canWrite && !!draft?.can_write && !!d?.writable;
  const edited = !!d && after !== d.after;
  const fileName = d?.path ? d.path.split("/").slice(-2).join("/") : null;
  const approve = () => {
    remember();
    onApprove(who, can && writeIt ? { after: edited ? after : null } : null);
  };

  return (
    <section className="approval" aria-label="A fix is waiting for your decision">
      <div className="approval-top">
        <div className="approval-what">
          <p className="approval-line">
            <strong>{capital(plural(changes, "change", "changes"))}</strong> ready to apply
            <span className="approval-change">
              <WithNames text={mitigation.summary.map(capital).join(", and ")} names={names} />
            </span>
          </p>
          <p className="approval-numbers">
            {mitigation.id} · tested in a sandbox graph · {verdictLine(mitigation)} · cost {mitigation.cost}
          </p>
          {d && (
            <p className="approval-seeline">
              <button className="link approval-see" onClick={() => setShowDraft((s) => !s)} aria-expanded={showDraft}>
                {showDraft ? "Hide the change to your config" : `See the change to ${KIND_WORDS[d.kind] ?? d.kind}${fileName ? ` · ${fileName}` : ""}`}
                {!showDraft && (can ? " · can be written" : "")}
              </button>
            </p>
          )}
        </div>
        <div className="approval-actions">
          <label className="approval-as">
            as <input type="text" value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="your name" maxLength={60} aria-label="Your name" />
          </label>
          {rejecting ? (
            <>
              <input className="approval-reason" type="text" value={reason} onChange={(e) => setRefusal({ id: mitigation.id, reason: e.target.value })} placeholder="why not (optional)" maxLength={300} autoFocus aria-label="Why not" />
              <Button variant="danger" size="lg" disabled={busy} onClick={() => { remember(); onReject(who, reason.trim()); }}>Reject the fix</Button>
              <Button variant="ghost" size="lg" disabled={busy} onClick={() => setRefusal(null)}>Back</Button>
            </>
          ) : (
            <>
              <Button size="lg" disabled={busy} onClick={() => setRefusal({ id: mitigation.id, reason: "" })}>Reject</Button>
              <Button variant="accent" size="lg" className="approve" disabled={busy} onClick={approve}>
                {can && writeIt ? "Approve · Apply · Write" : "Approve · Apply"}
              </Button>
            </>
          )}
        </div>
      </div>
      {d && showDraft && (
        <div className="approval-draft" aria-label="The change to your config">
          <div className="draft-head">
            <span className="eyebrow">Change to your config</span>
            <span className="draft-path">{d.path ?? (d.commands.length ? "commands to run" : "a brief, no file")}</span>
            {d.path && !d.commands.length && (
              editing
                ? <button className="link" onClick={() => setEditing(false)}>done editing</button>
                : <button className="link" onClick={() => setEditing(true)}>edit the text</button>
            )}
          </div>
          {editing ? (
            <textarea className="draft-edit" value={after} onChange={(e) => setAfter(e.target.value)} rows={14} spellCheck={false} aria-label="The text that would be written" />
          ) : d.commands.length ? (
            <pre className="draft-diff">{d.commands.join("\n")}</pre>
          ) : d.diff ? (
            <DiffLines text={edited ? `(edited by you; the diff below is the original draft)\n${d.diff}` : d.diff} />
          ) : (
            <pre className="draft-diff">{d.after || "(nothing this target can express)"}</pre>
          )}
          <p className="draft-note">{d.note}</p>
          <p className="draft-write">
            {can ? (
              <label>
                <input type="checkbox" checked={writeIt} onChange={(e) => setWriteIt(e.target.checked)} />
                {" "}Also write it to <code>{d.path}</code> when I approve. A backup is kept beside the file, and the scenario is read again from it.
              </label>
            ) : !canWrite ? (
              <>Shown to copy or download. Nothing is written to a file on a public site.</>
            ) : d.commands.length ? (
              <>Run these yourself; the gateway re-reads its profile on the next connection.</>
            ) : (
              <>There is nothing this target can write for this plan; the note above says why.</>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
