#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}=== YKF-AI 视频站一键部署向导 ===${NC}"

generate_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 16
        return
    fi

    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr -d '-' | tr 'A-Z' 'a-z'
        return
    fi

    if command -v shasum >/dev/null 2>&1; then
        date +%s%N | shasum -a 256 | awk '{print $1}' | cut -c1-32
        return
    fi

    date +%s%N
}

set_env_value() {
    local key="$1"
    local value="$2"

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if grep -q "^${key}=" .env; then
            sed -i '' "s|^${key}=.*|${key}=${value}|g" .env
        else
            echo "${key}=${value}" >> .env
        fi
    else
        if grep -q "^${key}=" .env; then
            sed -i "s|^${key}=.*|${key}=${value}|g" .env
        else
            echo "${key}=${value}" >> .env
        fi
    fi
}

read_required() {
    local prompt="$1"
    local value=""

    while [ -z "$value" ]; do
        read -p "$prompt" value
    done

    echo "$value"
}

# 1. 检查是否已存在 .env
if [ -f .env ]; then
    echo "检测到已存在配置文件 (.env)，将直接启动..."
    set -a
    . ./.env
    set +a
else
    echo "首次运行，请配置基本信息："
    cp .env.example .env
    
    # 交互式输入
    domain=$(read_required "请输入您的域名 (例如 https://ai.test.com): ")
    read -p "请输入运行端口 (默认 8090): " appPort
    apikey=$(read_required "请输入 KIE API Key: ")
    read -p "设置管理员账号 (默认 admin): " adminUsername
    adminPassword=$(read_required "设置管理员密码: ")
    token=$(generate_token)

    if [ -z "$appPort" ]; then
        appPort="8090"
    fi

    if [ -z "$adminUsername" ]; then
        adminUsername="admin"
    fi

    # 写入 .env
    set_env_value "PUBLIC_BASE_URL" "$domain"
    set_env_value "APP_PORT" "$appPort"
    set_env_value "KIE_API_KEY" "$apikey"
    set_env_value "APP_TOKEN" "$token"
    set_env_value "ADMIN_USERNAME" "$adminUsername"
    set_env_value "ADMIN_PASSWORD" "$adminPassword"
    
    echo -e "${GREEN}配置已生成！${NC}"
    set -a
    . ./.env
    set +a
fi

# 兼容缺省值
if [ -z "$APP_PORT" ]; then
    APP_PORT="8090"
fi

if [ -z "$ADMIN_USERNAME" ]; then
    ADMIN_USERNAME="admin"
fi

# 2. 赋予权限并启动
echo -e "${GREEN}正在构建并启动服务...${NC}"
chmod +x setup.sh
docker-compose down
docker-compose up -d --build

echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}✅ 部署成功！${NC}"
echo -e "🔌 本地地址: http://127.0.0.1:${APP_PORT}"
echo -e "🌐 您的域名: ${PUBLIC_BASE_URL}"
echo -e "🔑 KIE Key: 已配置"
echo -e "👤 管理员: ${ADMIN_USERNAME}"
echo -e ""
echo -e "⚠️ 请将您的域名反向代理到上述“本地地址” (端口 ${APP_PORT})"
echo -e "${GREEN}================================================${NC}"
