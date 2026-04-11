#!/bin/bash
echo "🔄 جاري التحديث من GitHub..."
cd /root/x-bot
git pull origin main
echo "📦 تحديث الحزم..."
npm install
echo "🔁 إعادة تشغيل البوت..."
pm2 restart xop-omer
echo "✅ تم التحديث بنجاح!"
pm2 status
