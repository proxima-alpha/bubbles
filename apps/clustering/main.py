import logging
from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from sklearn.cluster import AgglomerativeClustering

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("clustering")

app = FastAPI()


class ClusterRequest(BaseModel):
    vectors: list[list[float]]
    ids: list[str]
    min_cluster_size: int
    similarity_threshold: float


@app.post("/cluster")
def cluster(req: ClusterRequest):
    vectors = np.array(req.vectors)
    ids = req.ids
    logger.info(
        "cluster request: n=%d min_cluster_size=%d similarity_threshold=%.4f",
        len(ids), req.min_cluster_size, req.similarity_threshold,
    )

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    normed = vectors / np.where(norms == 0, 1, norms)
    sim_matrix = normed @ normed.T
    distance_matrix = np.clip(1 - sim_matrix, 0, 2)
    logger.info("ids: %s", ids)
    logger.info("similarity matrix:\n%s", np.round(sim_matrix, 4))

    distance_threshold = 1 - req.similarity_threshold
    model = AgglomerativeClustering(
        n_clusters=None,
        metric='precomputed',
        linkage='complete',
        distance_threshold=distance_threshold,
    )
    labels = model.fit_predict(distance_matrix)

    # min_cluster_size 미만인 클러스터는 noise로 처리
    from collections import Counter
    label_counts = Counter(labels)

    clusters: dict[int, list[str]] = {}
    noise: list[str] = []
    for idx, label in enumerate(labels):
        if label_counts[label] < req.min_cluster_size:
            noise.append(ids[idx])
        else:
            clusters.setdefault(int(label), []).append(ids[idx])

    logger.info(
        "cluster result: n_clusters=%d sizes=%s noise=%d",
        len(clusters), [len(v) for v in clusters.values()], len(noise),
    )

    return {
        "clusters": [{"label": k, "ids": v} for k, v in clusters.items()],
        "noise": noise,
    }
