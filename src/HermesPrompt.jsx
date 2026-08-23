import { useMemo, useState } from "react";

const APPROVAL_LABELS = {
  once: "이번만 허용",
  session: "이 세션에서 허용",
  always: "항상 허용",
  deny: "거부",
};

export default function HermesPrompt({ request, busy = false, onRespond }) {
  const [value, setValue] = useState("");
  const isApproval = request?.type === "approval.request";
  const isSecret = request?.type === "secret.request" || request?.type === "sudo.request";
  const choices = useMemo(() => {
    if (!request) return [];
    if (request.choices?.length) return request.choices;
    return isApproval ? ["once", "session", "deny"] : [];
  }, [isApproval, request]);

  if (!request) return null;

  const respond = async (answer) => {
    await onRespond(answer);
    setValue("");
  };

  return (
    <section className="hermes-hitl-prompt" role="alert" aria-live="assertive">
      <header>
        <span>{isApproval ? "HERMES APPROVAL" : isSecret ? "SECURE INPUT" : "HERMES QUESTION"}</span>
        <strong>{request.prompt}</strong>
        {request.envVar && <small>{request.envVar}</small>}
      </header>
      {choices.length > 0 && (
        <div className="hermes-hitl-choices">
          {choices.map((choice) => (
            <button
              type="button"
              key={choice}
              className={choice === "deny" ? "danger" : ""}
              disabled={busy}
              onClick={() => respond(choice)}
            >
              {APPROVAL_LABELS[choice] || choice}
            </button>
          ))}
        </div>
      )}
      {!isApproval && (
        <form onSubmit={(event) => { event.preventDefault(); respond(value); }}>
          <input
            autoFocus
            type={isSecret ? "password" : "text"}
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={isSecret ? "저장하지 않고 Hermes에 한 번만 전달합니다" : "답변 입력"}
          />
          <button type="submit" disabled={busy || (!value && request.type === "clarify.request")}>전달</button>
        </form>
      )}
      {request.error && <p>{request.error}</p>}
    </section>
  );
}
