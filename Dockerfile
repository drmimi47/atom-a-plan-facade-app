# Runs the Vite dev server (the user's chosen interim runtime). Client-only app;
# VITE_* vars are read at dev runtime and exposed to the browser bundle.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5174
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5174"]
