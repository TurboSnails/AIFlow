import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";

interface StageState {
  id: string;
  status: string;
}

export function Kanban() {
  const { id } = useParams<{ id: string }>();
  const [stages, setStages] = useState<StageState[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<{ stages: StageState[] }>(`/api/runs/${id}/stages`)
      .then((data) => setStages(data.stages))
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <div>Error: {error}</div>;

  const columns = [
    { title: "Pending", statuses: ["pending"] },
    { title: "Running", statuses: ["running"] },
    { title: "Waiting", statuses: ["waiting_human"] },
    { title: "Done", statuses: ["done"] },
  ];

  return (
    <div>
      <h1>Kanban: {id}</h1>
      <div style={{ display: "flex", gap: "1rem" }}>
        {columns.map((col) => (
          <div key={col.title} style={{ flex: 1, border: "1px solid #ccc", padding: "0.5rem" }}>
            <h2>{col.title}</h2>
            {stages
              .filter((s) => col.statuses.includes(s.status))
              .map((s) => (
                <div key={s.id}>{s.id}</div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
