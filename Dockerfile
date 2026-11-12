# 1. Imagen base: Python 3.12 oficial, en su versión liviana (slim)
FROM python:3.12-slim

# 2. Carpeta de trabajo dentro del contenedor
WORKDIR /app

# 3. Primero solo requirements.txt e instalar las dependencias.
#    Docker guarda cada paso en una "capa": mientras requirements.txt no cambie,
#    esta capa (la más lenta) se reutiliza y sale marcada como CACHED.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Ahora sí, solo lo que necesita la app (sin .env, .git ni notebooks)
COPY app/ app/
COPY frontend/ frontend/
COPY models/ models/

# 5. Documenta el puerto en el que escucha la app
EXPOSE 8000

# 6. Comando de arranque. 0.0.0.0 = acepta conexiones desde fuera del contenedor
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
