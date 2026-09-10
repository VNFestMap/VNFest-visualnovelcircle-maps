# VNFest 地图 — PHP 8 + Apache 镜像
# 构建方式: docker build -t ghcr.io/vnfestmap/galgame-community-map:latest .

FROM php:8.4-apache

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

LABEL org.opencontainers.image.source="https://github.com/VNFestMap/galgame-community-map"
LABEL org.opencontainers.image.description="VNFest Galgame 同好会地图"

# 安装系统依赖和 PHP 扩展
RUN set -eux \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        libpng-dev \
        libjpeg-dev \
        libfreetype6-dev \
        libonig-dev \
        libcurl4-openssl-dev \
        zip \
        unzip \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) \
        pdo_mysql \
        mbstring \
        curl \
        gd \
        bcmath \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 启用 Apache 模块
RUN a2enmod rewrite headers expires

# 配置 Apache 允许 .htaccess
ENV APACHE_DOCUMENT_ROOT=/var/www/html
RUN sed -ri \
    -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' \
    -e 's!/var/www/!${APACHE_DOCUMENT_ROOT}!g' \
    /etc/apache2/sites-available/*.conf \
    /etc/apache2/apache2.conf \
    /etc/apache2/conf-available/*.conf \
&& echo '<Directory "${APACHE_DOCUMENT_ROOT}">\n\
    AllowOverride All\n\
    Require all granted\n\
</Directory>' > /etc/apache2/conf-available/allow-override.conf \
&& a2enconf allow-override

# 复制应用代码
COPY . /var/www/html/

RUN cd /var/www/html \
    && composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader

# 创建持久化目录并设置权限
# uploads/ 和 wiki/uploads/ 被 .dockerignore 排除，需要提前创建作为挂载点
RUN mkdir -p /var/www/html/uploads /var/www/html/wiki/uploads /var/www/html/data/cache \
    && chown -R www-data:www-data /var/www/html/data /var/www/html/uploads /var/www/html/wiki \
    && chmod -R 755 /var/www/html/data /var/www/html/uploads /var/www/html/wiki

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost/api/health.php || exit 1
