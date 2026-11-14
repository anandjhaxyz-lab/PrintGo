/**
 * Cashfree Payment Gateway Adapter
 * API Version: 2023-08-01
 * 
 * Provides an isolated, testable interface for Cashfree orders, refunds, and verifications.
 * Supports:
 *   - Real Cashfree Sandbox / Production API calls when valid credentials exist.
 *   - Local deterministic mock mode for testing without external network calls.
 *   - Safe error, timeout, and response normalization.
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { getCashfreeConfig, validateCashfreeConfig, redactSensitiveData } = require('../config/cashfree.config');

class CashfreeGatewayAdapter {
  constructor() {
    this.mockMode = false;
    this.mockHandlers = {};
  }

  /**
   * Enables mock mode with custom or deterministic default handlers for unit/integration testing.
   */
  setMockMode(enabled = true, handlers = {}) {
    this.mockMode = enabled;
    this.mockHandlers = handlers;
  }

  /**
   * Creates a refund at Cashfree for a given order.
   */
  async createRefund({ orderId, refundId, amount, reason, speed = 'STANDARD' }) {
    if (this.mockMode) {
      if (this.mockHandlers.createRefund) {
        return await this.mockHandlers.createRefund({ orderId, refundId, amount, reason, speed });
      }

      // Default deterministic mock response
      return {
        success: true,
        cfRefundId: `cf_ref_mock_${Date.now()}`,
        refundId,
        orderId,
        amount: Number(amount),
        currency: 'INR',
        status: 'SUCCESS',
        rawResponse: {
          cf_refund_id: `cf_ref_mock_${Date.now()}`,
          refund_id: refundId,
          order_id: orderId,
          refund_amount: Number(amount),
          refund_currency: 'INR',
          refund_status: 'SUCCESS',
          status_description: 'Mock refund processed successfully'
        }
      };
    }

    const config = getCashfreeConfig();
    if (!config.validation.isValid) {
      logger.warn(`Cashfree refund rejected: ${config.validation.reason}`);
      throw new AppError(config.validation.reason, 400);
    }

    const url = `${config.orderUrl}/${orderId}/refunds`;
    const payload = {
      refund_amount: Number(amount),
      refund_id: refundId,
      refund_note: reason || 'Customer Refund',
      refund_speed: speed
    };

    try {
      logger.info(`Dispatching Cashfree refund request: order ${orderId}, refundId ${refundId}, amount ₹${amount}`);
      const response = await axios.post(url, payload, {
        headers: config.headers,
        timeout: config.timeout
      });

      const data = response.data;
      return {
        success: data.refund_status === 'SUCCESS' || data.refund_status === 'PENDING',
        cfRefundId: data.cf_refund_id ? String(data.cf_refund_id) : null,
        refundId: data.refund_id,
        orderId: data.order_id,
        amount: Number(data.refund_amount),
        currency: data.refund_currency || 'INR',
        status: data.refund_status, // SUCCESS, PENDING, FAILED, CANCELLED
        rawResponse: data
      };
    } catch (err) {
      const errResponse = err?.response?.data || { message: err.message };
      logger.error(`Cashfree refund API error for order ${orderId}:`, redactSensitiveData(errResponse));

      // Check for duplicate refund ID
      const isDuplicate = errResponse?.code === 'refund_already_exists' || 
                          errResponse?.message?.includes('already exists') ||
                          err?.response?.status === 409;

      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');

      return {
        success: false,
        isDuplicate,
        isTimeout,
        status: 'FAILED',
        error: errResponse?.message || err.message,
        statusCode: err?.response?.status || 500,
        rawResponse: errResponse
      };
    }
  }

  /**
   * Fetches refund details from Cashfree to reconcile gateway state.
   */
  async getRefundDetails(orderId, refundId) {
    if (this.mockMode) {
      if (this.mockHandlers.getRefundDetails) {
        return await this.mockHandlers.getRefundDetails(orderId, refundId);
      }
      return {
        success: true,
        cfRefundId: `cf_ref_mock_${refundId}`,
        refundId,
        orderId,
        status: 'SUCCESS',
        amount: 10.0,
        rawResponse: { refund_status: 'SUCCESS' }
      };
    }

    const config = getCashfreeConfig();
    if (!config.validation.isValid) {
      throw new AppError(config.validation.reason, 400);
    }

    const url = `${config.orderUrl}/${orderId}/refunds/${refundId}`;
    try {
      const response = await axios.get(url, {
        headers: config.headers,
        timeout: config.timeout
      });

      const data = response.data;
      return {
        success: true,
        cfRefundId: data.cf_refund_id ? String(data.cf_refund_id) : null,
        refundId: data.refund_id,
        orderId: data.order_id,
        amount: Number(data.refund_amount),
        status: data.refund_status,
        rawResponse: data
      };
    } catch (err) {
      const errResponse = err?.response?.data || { message: err.message };
      return {
        success: false,
        status: 'UNKNOWN',
        error: errResponse?.message || err.message,
        statusCode: err?.response?.status || 500,
        rawResponse: errResponse
      };
    }
  }

  /**
   * Fetches payment details from Cashfree for an order.
   */
  async getOrderPayments(orderId) {
    if (this.mockMode) {
      if (this.mockHandlers.getOrderPayments) {
        return await this.mockHandlers.getOrderPayments(orderId);
      }
      return {
        success: true,
        payments: [
          {
            cf_payment_id: 1234567,
            order_id: orderId,
            payment_amount: 50.0,
            payment_currency: 'INR',
            payment_status: 'SUCCESS',
            payment_method: { upi: { channel: 'gpay' } }
          }
        ]
      };
    }

    const config = getCashfreeConfig();
    if (!config.validation.isValid) {
      throw new AppError(config.validation.reason, 400);
    }

    const url = `${config.orderUrl}/${orderId}/payments`;
    try {
      const response = await axios.get(url, {
        headers: config.headers,
        timeout: config.timeout
      });

      return {
        success: true,
        payments: response.data || []
      };
    } catch (err) {
      return {
        success: false,
        error: err?.response?.data?.message || err.message,
        payments: []
      };
    }
  }

  /**
   * Fetches order details from Cashfree for lifecycle reconciliation.
   */
  async getOrderDetails(orderId) {
    if (this.mockMode) {
      if (this.mockHandlers.getOrderDetails) {
        return await this.mockHandlers.getOrderDetails(orderId);
      }
      return {
        success: true,
        orderId,
        order_status: 'ACTIVE',
        order_amount: 10.0,
        order_currency: 'INR',
        payment_session_id: `session_mock_${orderId}`,
        rawResponse: { order_status: 'ACTIVE', payment_session_id: `session_mock_${orderId}` }
      };
    }

    const config = getCashfreeConfig();
    if (!config.validation.isValid) {
      throw new AppError(config.validation.reason, 400);
    }

    const url = `${config.orderUrl}/${orderId}`;
    try {
      const response = await axios.get(url, {
        headers: config.headers,
        timeout: config.timeout
      });

      const data = response.data || {};
      return {
        success: true,
        orderId: data.order_id || orderId,
        order_status: data.order_status, // ACTIVE, PAID, EXPIRED, TERMINATED
        order_amount: Number(data.order_amount),
        order_currency: data.order_currency || 'INR',
        payment_session_id: data.payment_session_id || null,
        rawResponse: data
      };
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const isNotFound = statusCode === 404;
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      return {
        success: false,
        statusCode,
        isNotFound,
        isTimeout,
        error: err?.response?.data?.message || err.message,
        rawResponse: err?.response?.data || null
      };
    }
  }

  /**
   * Verifies Cashfree webhook HMAC SHA256 signature using raw request body.
   */
  verifyWebhookSignature(signature, rawBody, timestamp) {
    const secretKey = process.env.CASHFREE_SECRET_KEY;
    if (!secretKey || !signature || !rawBody) return false;

    try {
      // Signature payload: timestamp + rawBody
      const dataToSign = timestamp ? `${timestamp}${rawBody}` : rawBody;
      const expectedSignature = crypto
        .createHmac('sha256', secretKey)
        .update(dataToSign)
        .digest('base64');

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (e) {
      logger.error('Webhook signature verification exception:', e.message);
      return false;
    }
  }
}

// Export singleton instance
const cashfreeGateway = new CashfreeGatewayAdapter();

module.exports = cashfreeGateway;
