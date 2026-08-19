# Kubernetes install

For a single host see [Docker Compose](./docker-compose.md). For local dev see [Manual](manual.md).

> **The committed manifests are templates.** `secrets.yaml` ships with `CHANGE_ME` placeholders and `ingress.yaml` references `novamem.example.com`. Do **not** `kubectl apply -k deploy/k8s/` as-is — follow [Configure](#configure) first.

## Layout

```
deploy/k8s/
├── kustomization.yaml   # bundles the rest into namespace `novamem`
├── namespace.yaml
├── secrets.yaml         # TEMPLATE — placeholders only, see "Secrets"
├── postgres.yaml        # StatefulSet · Service · PVC
├── qdrant.yaml          # StatefulSet · Service · PVC
├── novamem.yaml         # ConfigMap · Deployment · ClusterIP Service
└── ingress.yaml         # cert-manager Ingress with TLS
```

## Image

The manifest pulls a public multi-arch image (`linux/amd64` + `linux/arm64`) from GitHub Container Registry:

```
ghcr.io/azrtydxb/novamem:main         # mutable, rebuilt on every main push by CI
ghcr.io/azrtydxb/novamem:sha-<short>  # immutable per commit, also multi-arch
```

CI builds, scans (Trivy HIGH/CRITICAL with `--ignore-unfixed`), and pushes both tags from the [CI workflow](https://github.com/azrtydxb/novamem/blob/main/.github/workflows/ci.yml). The `:main` tag updates on every push to the `main` branch; pin `image:` to a `:sha-…` tag in `novamem.yaml` if you want immutability.

To roll forward after a CI publish:

```bash
kubectl -n novamem rollout restart deploy/novamem
```

To build locally and bypass the registry (e.g. in an air-gapped lab) — set `image: novamem:dev` and `imagePullPolicy: Never` in `novamem.yaml`, then:

```bash
docker build -t novamem:dev .
docker save novamem:dev | sudo k3s ctr images import -
```

## Configure

### Secrets

`deploy/k8s/secrets.yaml` is a **template**. The values are intentionally `CHANGE_ME` — anything you paste in there ends up in git history. Pick one of the patterns below.

**Pattern A — `kubectl create secret` (simplest).** Skip the templated `secrets.yaml` entirely: remove it from `kustomization.yaml` (or apply the rest with `--prune`-style discipline) and create the Secret out-of-band:

```bash
kubectl create namespace novamem

POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' )"

kubectl create secret generic novamem-secrets -n novamem \
  --from-literal=NOVAMEM_COOKIE_SECRET="$(openssl rand -hex 32)" \
  --from-literal=NOVAMEM_BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
  --from-literal=NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  --from-literal=NOVAMEM_WARM_URL="postgres://novamem:${POSTGRES_PASSWORD}@postgres.novamem.svc.cluster.local:5432/novamem"
```

**Pattern B — Sealed Secrets.** Install [bitnami-labs/sealed-secrets](https://github.com/bitnami-labs/sealed-secrets) and `kubeseal` your filled-in `secrets.yaml` into a `SealedSecret` CR. The encrypted CR is safe to commit; the controller decrypts it in-cluster.

**Pattern C — external-secrets-operator.** Install [external-secrets](https://external-secrets.io/) and define an `ExternalSecret` that pulls from Vault, AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault. Drop `secrets.yaml` from the kustomization in favor of the `ExternalSecret`.

The keys consumed by the Deployment (`envFrom: secretRef`) are:

| Key                                | Notes                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `NOVAMEM_COOKIE_SECRET`            | Session signing. `openssl rand -hex 32`. Rotate to invalidate all sessions.            |
| `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL`    | First admin (only consulted when no admin user exists).                                |
| `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` | First admin password. Auto-scrubbed from `process.env` after the seed runs.            |
| `POSTGRES_PASSWORD`                | Mounted into the Postgres StatefulSet as well.                                         |
| `NOVAMEM_WARM_URL`                 | Full Postgres DSN — embeds the password, so it lives in the Secret, not the ConfigMap. |

### App config

`deploy/k8s/novamem.yaml` (ConfigMap):

- `NOVAMEM_BASE_URL` — set to your TLS-terminated origin (the Ingress hostname). Better Auth's trusted-origin check rejects mismatches.
- `NOVAMEM_INSECURE_COOKIES` — leave at `"0"` in production. Only flip to `"1"` for a local HTTP-only smoke test.

### Ingress + TLS

`deploy/k8s/ingress.yaml` is a working example for [cert-manager](https://cert-manager.io/) + [nginx-ingress](https://kubernetes.github.io/ingress-nginx/) on Let's Encrypt. To use it:

1. Install an Ingress controller. nginx-ingress works out of the box; Traefik / HAProxy / cloud-native (GKE / EKS / AKS) controllers all work — adjust `ingressClassName` and the `ssl-redirect` annotation accordingly.
2. Install cert-manager and create a `ClusterIssuer`. The example references `letsencrypt-prod`:
   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata: { name: letsencrypt-prod }
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       email: ops@example.com
       privateKeySecretRef: { name: letsencrypt-prod }
       solvers:
         - http01: { ingress: { class: nginx } }
   ```
3. Replace `novamem.example.com` in `ingress.yaml` with your DNS name and point that name at your Ingress controller's external IP.
4. Set `NOVAMEM_BASE_URL` in `novamem.yaml` to `https://<your-domain>`.

**Alternatives.** If you don't want cert-manager, terminate TLS at a cloud load balancer (GCLB managed certs, AWS ALB + ACM, Azure Application Gateway) and point a `Service: type=LoadBalancer` at it — but only if the LB does the TLS, not the app. The app speaks plain HTTP and never gets a certificate of its own.

## Apply

After you've created the Secret out-of-band (Pattern A) or sealed/synced it (B/C), and after you've updated `NOVAMEM_BASE_URL` and the Ingress hostname:

```bash
kubectl apply -k deploy/k8s/

kubectl -n novamem rollout status statefulset/postgres
kubectl -n novamem rollout status statefulset/qdrant
kubectl -n novamem rollout status deploy/novamem
```

## Reach the API

The Service is `ClusterIP` — reach it through the Ingress on `https://<your-domain>`. Sign in at `https://<your-domain>/admin` with the bootstrap admin email + password.

For a quick in-cluster sanity check without DNS, port-forward:

```bash
kubectl -n novamem port-forward svc/novamem 7778:7778
# then http://localhost:7778/health   (note: cookies won't work on http,
# this is for /health probes only)
```

## Persistence

Each StatefulSet uses a `volumeClaimTemplates` against the cluster's default StorageClass. On k3s that's `local-path` — node-local, not migratable. For HA storage swap in your CSI provider before first apply.

To back up:

```bash
kubectl -n novamem exec sts/postgres -- pg_dump -U novamem -d novamem -Fc > novamem-warm.dump
# Qdrant: kubectl exec into the pod and POST /collections/<name>/snapshots
```

## Updates

`:main` is mutable, so CI publishing a new image + a rollout restart is enough:

```bash
kubectl -n novamem rollout restart deploy/novamem
kubectl -n novamem rollout status  deploy/novamem
```

To pin to a specific commit instead of tracking `:main`:

```bash
kubectl -n novamem set image deploy/novamem novamem=ghcr.io/azrtydxb/novamem:sha-<short>
```

Schema migrations are forward-only — back up Postgres before rolling.

## Troubleshooting

```bash
kubectl -n novamem get pods
kubectl -n novamem logs deploy/novamem
kubectl -n novamem describe pod -l app=novamem
```

- Pod stuck in `CrashLoopBackOff` → almost always missing `NOVAMEM_COOKIE_SECRET` or unreachable Postgres. Check the Secret was created (`kubectl -n novamem get secret novamem-secrets`) and that `NOVAMEM_WARM_URL` is set inside it.
- `403 Invalid origin` on sign-in → `NOVAMEM_BASE_URL` doesn't match the browser's URL. It must be the exact `https://` Ingress hostname.
- Cookies missing on sign-in over HTTPS → confirm `NOVAMEM_INSECURE_COOKIES=0` and that the Ingress is terminating TLS (not passing through).
- cert-manager Certificate stuck `Pending` → check the `Order` / `Challenge` resources. Most often DNS for the host doesn't yet resolve to the Ingress IP.
- Slow first search → local embedder is downloading the model. Subsequent calls are fast; the model lives in the pod's ephemeral volume so it re-downloads on every restart unless you mount a PVC for it.
