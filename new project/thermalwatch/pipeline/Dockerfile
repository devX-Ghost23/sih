FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*
COPY pipeline/requirements.txt pipeline/requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements-optional.txt
COPY db /app/db
COPY pipeline /app/pipeline
WORKDIR /app/pipeline
ENV PYTHONPATH=/app/pipeline MODEL_PATH=/app/pipeline/models/xgb_model.json
ENTRYPOINT ["python", "-m", "thermalwatch.cli"]
CMD ["--help"]
