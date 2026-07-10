import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";

interface DebateRound {
  round: number;
  topic: string;
}

export function Debate() {
  const { id } = useParams<{ id: string }>();
  const [debates, setDebates] = useState<DebateRound[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<{ debates: DebateRound[] }>(`/api/runs/${id}/debates`)
      .then((data) => setDebates(data.debates))
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h1>Debate: {id}</h1>
      <ul>
        {debates.map((d, i) => (
          <li key={i}>
            Round {d.round}: {d.topic}
          </li>
        ))}
      </ul>
    </div>
  );
}
