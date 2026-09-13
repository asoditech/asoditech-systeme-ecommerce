-- One new in-app notification type — a new order's requested quantity
-- exceeds current available stock for one of its lines
-- (src/lib/notifications.ts's checkAndNotifyInsufficientStockForOrder).
-- Read-only alert; never mutates stock. Same pattern as
-- 20260912010000_plans_entitlements_usage's own ADD VALUE (not used
-- within this same migration transaction — see that file's comment).
ALTER TYPE "NotificationType" ADD VALUE 'STOCK_INSUFFISANT_COMMANDE';
