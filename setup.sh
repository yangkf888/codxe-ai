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

# 1. 检查是否已存在 .env
if [ -f .env ]; then
    echo "检测到已存在配置文件 (.env)，将直接启动..."
else
    echo "首次运行，请配置基本信息："
    cp .env.example .env
    
    # 交互式输入
    read -p "请输入你的域名 (例如 https://ai.test.com): " domain
    read -p "请输入 KIE API Key: " apikey
    read -p "请输入管理员账号 (默认 admin): " adminUsername
    read -p "请输入管理员密码 (默认 123456): " adminPassword
    token=$(generate_token)

    if [ -z "$adminUsername" ]; then
        adminUsername="admin"
    fi

    if [ -z "$adminPassword" ]; then
        adminPassword="123456"
    fi
    
    # 写入 .env (使用 sed 替换)
    # Mac/Linux 兼容写法
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|PUBLIC_BASE_URL=|PUBLIC_BASE_URL=$domain|g" .env
        sed -i '' "s|KIE_API_KEY=|KIE_API_KEY=$apikey|g" .env
        sed -i '' "s|APP_TOKEN=|APP_TOKEN=$token|g" .env
        sed -i '' "s|ADMIN_USERNAME=|ADMIN_USERNAME=$adminUsername|g" .env
        sed -i '' "s|ADMIN_PASSWORD=|ADMIN_PASSWORD=$adminPassword|g" .env
    else
        sed -i "s|PUBLIC_BASE_URL=|PUBLIC_BASE_URL=$domain|g" .env
        sed -i "s|KIE_API_KEY=|KIE_API_KEY=$apikey|g" .env
        sed -i "s|APP_TOKEN=|APP_TOKEN=$token|g" .env
        sed -i "s|ADMIN_USERNAME=|ADMIN_USERNAME=$adminUsername|g" .env
        sed -i "s|ADMIN_PASSWORD=|ADMIN_PASSWORD=$adminPassword|g" .env
    fi
    
    echo -e "${GREEN}配置已生成！${NC}"
fi

# 2. 赋予权限并启动
echo -e "${GREEN}正在构建并启动服务...${NC}"
chmod +x setup.sh
docker-compose down
docker-compose up -d --build

echo -e "${GREEN}==============================${NC}"
echo -e "${GREEN}部署完成！${NC}"
echo -e "请访问: $domain"
echo -e "${GREEN}==============================${NC}"
