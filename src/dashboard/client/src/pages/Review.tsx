import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";

interface ReviewIssue {
  reviewer: string;
  severity: string;
  summary: string;
}

export function Review() {
  const { id } = useParams<{ id: string }>();
  const [reviews, setReviews] = useState<ReviewIssue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<{ reviews: ReviewIssue[] }>(`/api/runs/${id}/reviews`)
      .then((data) => setReviews(data.reviews))
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h1>Review: {id}</h1>
      <ul>
        {reviews.map((r, i) => (
          <li key={i}>
            {r.reviewer} [{r.severity}]: {r.summary}
          </li>
        ))}
      </ul>
    </div>
  );
}
