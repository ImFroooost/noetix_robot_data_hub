FROM node:22-alpine AS build
WORKDIR /app
# 按 lock 文件安装，保证每次构建拿到同一套依赖版本
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
