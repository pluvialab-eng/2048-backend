# Dockerfile
FROM node:20-alpine
WORKDIR /app

# package.json'ı kopyala. lockfile olsa da olmasa da sorun çıkarmayalım:
COPY package.json ./
# Varsa package-lock.json'ı da kopyala (yoksa bu satır hatasız atlanır)
COPY package-lock.json* ./

# Lockfile yoksa da çalışsın:
RUN npm install --omit=dev

# Uygulama dosyaları
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
