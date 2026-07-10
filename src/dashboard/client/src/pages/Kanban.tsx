import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";

interface StageEvent {
  id: number;
  type: string;
  stage: string;
}

export function Kanban() {
  const { id } = useParams<{ id: string }>();
  const [stages, setStages] = useState<StageEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<{ stages: StageEvent[] }>(`/api/runs/${id}/stages`)
      .then((data) => setStages(data.stages))
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <div>Error: {error}</div>;

  const columns = [
    { title: "Pending", types: ["stage_pending"] },
    { title: "Running", types: ["stage_start"] },
    { title: "Waiting", types: ["human_gate"] },
    { title: "Done", types: ["stage_done"] },
  ];

  return (
    <div>
      <h1>Kanban: {id}</h1>
      <div style={{ display: "flex", gap: "1rem" }}>
        {columns.map((col) => (
          <div key={col.title} style={{ flex: 1, border: "1px solid #ccc", padding: "0.5rem" }}>
            <h2>{col.title}</h2>
            {stages
              .filter((s) => col.types.includes(s.type))
              .map((s) => (
                <div key={s.id}>{s.stage}</div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
