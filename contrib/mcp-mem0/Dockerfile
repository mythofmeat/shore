FROM docker pull python:slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ARG EMBEDDER=BAAI/bge-small-en-v1.5
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${EMBEDDER}')"

COPY mem0_config.py server.py backfill.py ./

ENV MEM0_STORE=/data
ENV HOME=/data
EXPOSE 3000
CMD ["python", "server.py"]
