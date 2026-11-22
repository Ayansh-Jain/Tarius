{{/*
Common template helpers for the ICE chart (naming + labels).
*/}}

{{/* Base name, overridable via nameOverride. */}}
{{- define "ice.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified release name. If fullnameOverride is set, use it verbatim.
Otherwise <release>-<name>, collapsing the duplicate when the release already
contains the chart name (Helm convention).
*/}}
{{- define "ice.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Chart label "name-version". */}}
{{- define "ice.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels shared by every object in this release. */}}
{{- define "ice.labels" -}}
helm.sh/chart: {{ include "ice.chart" . }}
{{ include "ice.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ice
{{- end -}}

{{/* Selector labels (immutable subset). */}}
{{- define "ice.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ice.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Name of the Secret holding session + LiveKit creds (existing or chart-made). */}}
{{- define "ice.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "ice.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* DNS name of the in-cluster server Service used by the web edge + clients. */}}
{{- define "ice.serverServiceName" -}}
{{- if .Values.web.serverServiceName -}}
{{- .Values.web.serverServiceName -}}
{{- else -}}
{{- printf "%s-server" (include "ice.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Resolve an image tag, defaulting to the chart appVersion. */}}
{{- define "ice.imageTag" -}}
{{- default .root.Chart.AppVersion .tag -}}
{{- end -}}
