from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from sklearn.cluster import AgglomerativeClustering

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

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    normed = vectors / np.where(norms == 0, 1, norms)
    sim_matrix = normed @ normed.T
    distance_matrix = np.clip(1 - sim_matrix, 0, 2)

    distance_threshold = 1 - req.similarity_threshold
    model = AgglomerativeClustering(
        n_clusters=None,
        metric='precomputed',
        linkage='single', # 하나라도 threshold 를 넘는 경우가 있으면 한 그룹으로 묶음
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

    return {
        "clusters": [{"label": k, "ids": v} for k, v in clusters.items()],
        "noise": noise,
    }
