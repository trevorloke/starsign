import type { VisAnswer } from "../../lib/visibility";
import { engineLabel, positionLabel } from "../../lib/visibility";
import { languageName } from "../../lib/lang";
import { formatDateTime } from "../../lib/time";
import { HighlightedText, Tone } from "./parts";

/** One answer in full: the question as sent, the text with every tracked name marked, what it said about each, and its sources. */
export function AnswerView({ answer, relationOf, onBack }: { answer: VisAnswer; relationOf: (entityId: string) => string | undefined; onBack: () => void }) {
  const named = answer.mentions.filter((m) => m.mentioned);
  const missed = answer.mentions.filter((m) => !m.mentioned);
  return (
    <div className="vis-answer-view">
      <section className="dsec">
        <button type="button" className="btn btn-small btn-ghost vis-back" onClick={onBack}>
          ← Back to the report
        </button>
        <div className="vis-answer-meta">
          <span className="tag vis-engine-tag">{engineLabel(answer.engine)}</span>
          {answer.model ? <span className="tag mono">{answer.model}</span> : null}
          <span className="tag">{languageName(answer.lang)}</span>
          {answer.region ? <span className="tag">Asked from {answer.region}</span> : null}
          <span className="muted small">{formatDateTime(answer.askedAt)}</span>
        </div>
        <h3 className="vis-answer-title">{answer.question}</h3>
        {answer.question !== answer.prompt ? <p className="muted small">Saved as: {answer.prompt}</p> : null}
        <p className="muted small vis-note">One answer is one sample. Ask the same question again and the wording, the order and the sources change.</p>
      </section>

      <section className="dsec">
        <h3 className="section-h">The answer</h3>
        {answer.status === "ok" ? (
          <div className="vis-answer-box">
            <HighlightedText answer={answer} relationOf={relationOf} />
          </div>
        ) : (
          <p className="muted">{answer.status === "capped" ? "Not asked: the workspace had reached its monthly model spend cap." : `The engine failed: ${answer.error ?? "unknown error"}`}</p>
        )}
      </section>

      {answer.status === "ok" ? (
        <section className="dsec">
          <h3 className="section-h">What it said about each name</h3>
          {named.length ? (
            <ul className="vis-said">
              {named.map((m) => (
                <li key={m.entityId} className="vis-said-row">
                  <div className="vis-said-head">
                    <span className="mono vis-pos" title="Order among your tracked names in this answer">
                      {positionLabel(m.position)}
                    </span>
                    <span className="strong">{m.name}</span>
                    {m.term && m.term !== m.name ? <span className="muted small">as “{m.term}”</span> : null}
                    <Tone value={m.sentiment} />
                    {m.ownCitations ? <span className="tag vis-own-tag">{m.ownCitations === 1 ? "cites its site" : `cites its site ${m.ownCitations}×`}</span> : null}
                  </div>
                  {m.summary ? <p className="small vis-said-summary">{m.summary}</p> : <p className="muted small">No summary: no model was configured to read this answer.</p>}
                  {m.flags.map((f) => (
                    <p key={f} className="small vis-flag" role="note">
                      Check this: {f}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">It named none of your tracked names.</p>
          )}
          {missed.length ? <p className="muted small vis-missed">Not named: {missed.map((m) => m.name).join(", ")}</p> : null}
        </section>
      ) : null}

      {answer.status === "ok" ? (
        <section className="dsec">
          <h3 className="section-h">Sources it cited</h3>
          {answer.citations.length ? (
            <ol className="vis-cites">
              {answer.citations.map((c) => (
                <li key={c.url}>
                  <a href={c.url} target="_blank" rel="noreferrer" className="vis-cite-link">
                    {c.title || c.domain}
                  </a>
                  <span className="muted small mono"> {c.domain}</span>
                  {c.ownerEntityId ? <span className="tag vis-own-tag">{answer.mentions.find((m) => m.entityId === c.ownerEntityId)?.name ?? "own"} site</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No sources: the engine answered from what it already knew.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
