from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
import hdbscan

app = FastAPI()


class ClusterRequest(BaseModel):
    vectors: list[list[float]]
    ids: list[str]
    min_cluster_size: int = 2


@app.post("/cluster")
def cluster(req: ClusterRequest):
    vectors = np.array(req.vectors)
    ids = req.ids

    clusterer = hdbscan.HDBSCAN(min_cluster_size=req.min_cluster_size, metric='cosine')
    labels = clusterer.fit_predict(vectors)

    clusters: dict[int, list[str]] = {}
    noise: list[str] = []
    for idx, label in enumerate(labels):
        if label == -1:
            noise.append(ids[idx])
        else:
            clusters.setdefault(int(label), []).append(ids[idx])

    return {
        "clusters": [{"label": k, "ids": v} for k, v in clusters.items()],
        "noise": noise,
    }
