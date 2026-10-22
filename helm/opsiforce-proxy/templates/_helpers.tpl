{{- define "opsiforce-proxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "opsiforce-proxy.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "opsiforce-proxy.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "opsiforce-proxy.labels" -}}
helm.sh/chart: {{ include "opsiforce-proxy.chart" . }}
{{ include "opsiforce-proxy.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "opsiforce-proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opsiforce-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "opsiforce-proxy.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "opsiforce-proxy.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "opsiforce-proxy.proxyPort" -}}
{{- if eq .Values.auth.mode "static" }}
{{- .Values.service.port }}
{{- else }}
{{- 4180 }}
{{- end }}
{{- end }}

{{- define "opsiforce-proxy.staticGroups" -}}
{{- $tenant := printf "role:opsiforce_tenant_name_%s" .Values.auth.static.tenantName }}
{{- $roles := list $tenant }}
{{- range .Values.auth.static.permissions }}
{{- $roles = append $roles (printf "role:opsiforce_%s" .) }}
{{- end }}
{{- join "," $roles }}
{{- end }}

{{- define "opsiforce-proxy.staticHeaders" -}}
proxy_set_header X-Forwarded-User "{{ .Values.auth.static.userId }}";
proxy_set_header X-Forwarded-Preferred-Username "{{ .Values.auth.static.preferredUsername }}";
proxy_set_header X-Forwarded-Email "{{ .Values.auth.static.email }}";
proxy_set_header X-Forwarded-Groups "{{ include "opsiforce-proxy.staticGroups" . }}";
{{- end }}

{{- define "opsiforce-proxy.dropOpsiforceHeaders" -}}
proxy_set_header X-Opsiforce-Caller "";
proxy_set_header X-Opsiforce-Expected-Manifest "";
{{- end }}
