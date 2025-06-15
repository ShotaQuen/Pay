// QRIS Payment Handler for OkeConnect API
const axios = require('axios');
const FormData = require('form-data');
const QRCode = require('qrcode');
const { Readable } = require('stream');
const settings = require('./settings'); // Add this line to import settings

// Helper Functions
function convertCRC16(input) {
  let crc = 0xffff;
  const length = input.length;
  
  for (let i = 0; i < length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  
  let result = crc & 0xffff;
  result = ('000' + result.toString(16).toUpperCase()).slice(-4);
  return result;
}

function generateTransactionId(prefix = 'QRIS') {
  const timestamp = Date.now().toString().slice(-5);
  const randomStr = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}${timestamp}${randomStr}`;
}

function generateExpirationTime(minutes = parseInt(settings.ORKUT_QRIS_EXPIRY_MINUTES) || 15) {
  const expiration = new Date();
  expiration.setMinutes(expiration.getMinutes() + minutes);
  return expiration;
}

async function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

async function uploadQrToCatbox(qrBuffer) {
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    
    const qrStream = await bufferToStream(qrBuffer);
    form.append('fileToUpload', qrStream, {
      filename: `qr_${settings.APP_NAME.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.png`,
      contentType: 'image/png'
    });
    
    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 15000
    });
    
    if (!response.status || typeof response.data !== 'string' || !response.data.includes('http')) {
      console.error('Catbox upload failed, response:', response.data);
      throw new Error('Gagal mengunggah QR ke Catbox.');
    }
    
    return response.data;
  } catch (error) {
    console.error('Error uploading to Catbox:', error.stack);
    throw error;
  }
}

// Main QRIS Functions
async function createDynamicOrkutQris(amount, note = 'Pembayaran') {
  try {
    const staticCode = settings.ORKUT_QRIS_STATIC_CODE;
    const feePercentage = parseFloat(settings.ORKUT_QRIS_FEE_PERCENTAGE || 0.7);
    const feeByCustomer = settings.ORKUT_QRIS_FEE_BY_CUSTOMER_DEPOSIT === 'true';
    
    if (!staticCode) throw new Error('Kode QRIS statis dasar (ORKUT_QRIS_STATIC_CODE) diperlukan.');
    
    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount)) throw new Error('Jumlah tidak valid.');
    
    let totalAmount = parsedAmount;
    let feeAmount = 0;
    
    // Calculate fee
    if (feeByCustomer && feePercentage > 0) {
      feeAmount = Math.ceil(parsedAmount * (feePercentage / 100));
      totalAmount = parsedAmount + feeAmount;
    } else if (!feeByCustomer && feePercentage > 0) {
      feeAmount = Math.ceil(parsedAmount * (feePercentage / 100));
    }
    
    // Prepare QRIS code
    let qrisCode = staticCode;
    if (qrisCode.length > 12 && qrisCode.substring(6, 12) === '010212') {
      qrisCode = qrisCode.substring(0, 6) + '010211' + qrisCode.substring(12);
    }
    
    const amountTag = '5802ID';
    const amountPos = qrisCode.indexOf(amountTag);
    if (amountPos === -1) throw new Error('Format kode QRIS dasar tidak valid (5802ID tidak ditemukan).');
    
    const prefix = qrisCode.substring(0, amountPos);
    const suffix = qrisCode.substring(amountPos);
    const amountStr = totalAmount.toString();
    const paddedAmount = ('0' + amountStr.length).slice(-2);
    const amountData = '54' + paddedAmount + amountStr;
    const qrisString = prefix + amountData + suffix;
    
    // Calculate CRC
    const crcInput = qrisString.slice(0, -4);
    const crc = convertCRC16(crcInput);
    const finalQrisString = crcInput + crc;
    
    console.log('Payload untuk CRC baru:', crcInput);
    console.log('String QRIS Final (dari kode INO):', finalQrisString);
    
    // Generate QR Code
    const qrImage = await QRCode.toBuffer(finalQrisString, {
      errorCorrectionLevel: 'M',
      type: 'png',
      margin: 2,
      width: 300,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    
    // Upload QR to Catbox
    const qrUrl = await uploadQrToCatbox(qrImage);
    const transactionId = generateTransactionId('ORD');
    const expirationTime = generateExpirationTime();
    
    return {
      success: true,
      orkutReffId: transactionId,
      amountToPayWithFee: totalAmount,
      originalAmount: parsedAmount,
      feeAmount: feeAmount,
      qrImageUrl: qrUrl,
      qrString: finalQrisString,
      expiredAt: expirationTime,
      paymentMethod: 'QRIS',
      message: 'QRIS berhasil dibuat.'
    };
  } catch (error) {
    console.error('Error creating Orkut QRIS:', error.message, error.stack);
    return {
      success: false,
      message: error.message || 'Gagal membuat QRIS Orkut.'
    };
  }
}

async function checkOrkutQrisPaymentStatus(referenceId, amount, sinceDate) {
  try {
    const merchantId = settings.OKECONNECT_MERCHANT_ID;
    const apiKey = settings.OKECONNECT_API_KEY;
    
    if (!merchantId || !apiKey) {
      console.error('OKECONNECT Merchant ID dan API Key diperlukan untuk cek status.');
      return {
        success: false,
        isPaid: false,
        message: 'Konfigurasi OkeConnect tidak lengkap.'
      };
    }
    
    const minutesBack = 30;
    const defaultFromDate = new Date(Date.now() - minutesBack * 60 * 1000);
    const fromDate = sinceDate ? new Date(Math.max(sinceDate, defaultFromDate.getTime())) : defaultFromDate;
    const dateString = fromDate.toISOString().split('T')[0];
    
    const apiUrl = `https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apiKey}?date_from=${dateString}`;
    const response = await axios.get(apiUrl, { timeout: 15000 });
    
    if (response.data && response.data.status === 'success' && Array.isArray(response.data.data)) {
      const mutations = response.data.data;
      const refSuffix = referenceId.toLowerCase().slice(-8);
      
      const transaction = mutations.find(entry => {
        const entryAmount = parseInt(entry.amount);
        const hasReference = entry.note && entry.note.toLowerCase().includes(refSuffix);
        return entryAmount === amount && hasReference;
      });
      
      return transaction ? {
        success: true,
        isPaid: true,
        transaction: transaction,
        message: 'Pembayaran ditemukan.'
      } : {
        success: true,
        isPaid: false,
        message: 'Pembayaran belum ditemukan dalam mutasi terbaru.'
      };
    } else {
      if (response.data && response.data.msg) {
        return {
          success: false,
          isPaid: false,
          message: 'OkeConnect: ' + response.data.msg
        };
      }
    }
    
    return {
      success: false,
      isPaid: false,
      message: 'Format respons API Okeconnect tidak valid.'
    };
  } catch (error) {
    console.error('Error checking Orkut QRIS status (OkeConnect):',
      error.response ? error.response.data : error.message);
    
    let errorMessage = error.message || 'Gagal menghubungi OkeConnect.';
    if (error.response && error.response.data && error.response.data.msg) {
      errorMessage = 'OkeConnect: ' + error.response.data.msg;
    }
    
    return {
      success: false,
      isPaid: false,
      message: errorMessage
    };
  }
}

async function getLatestMutations() {
  try {
    const merchantId = settings.OKECONNECT_MERCHANT_ID;
    const apiKey = settings.OKECONNECT_API_KEY;
    
    if (!merchantId || !apiKey) return 'Konfigurasi OkeConnect tidak lengkap.';
    
    const apiUrl = `https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apiKey}`;
    const response = await axios.get(apiUrl, { timeout: 15000 });
    const responseData = response.data;
    
    if (!responseData || typeof responseData !== 'object') {
      throw new Error('Format respons API Okeconnect tidak valid.');
    }
    
    let result = `*Mutasi Terakhir - ${settings.APP_NAME}*\n==================\n\n`;
    
    if (responseData.status && String(responseData.status).toLowerCase() === 'failed' && responseData.msg) {
      result += '⚠️ ' + responseData.msg + '\n';
    } else {
      if (!responseData.data || (Array.isArray(responseData.data) && responseData.data.length === 0)) {
        result += 'ℹ️ Tidak ada data mutasi terbaru.';
        if (responseData.msg) result += ' (' + responseData.msg + ')';
      } else {
        if (Array.isArray(responseData.data)) {
          responseData.data.slice(0, 10).forEach(entry => {
            result += '📅 ' + entry.date +
              '\n🏦 ' + entry.brand_name +
              '\n💰 Rp ' + parseInt(entry.amount).toLocaleString('id-ID') + '\n';
            if (entry.note) result += '📝 ' + entry.note + '\n';
            result += '------------------\n';
          });
          
          if (responseData.data.length > 10) {
            result += '\n... dan ' + (responseData.data.length - 10) + ' lainnya.';
          }
        } else {
          result += '⚠️ Format data mutasi tidak dikenali.';
          if (responseData.msg) result += ' (' + responseData.msg + ')';
        }
      }
    }
    
    return result;
  } catch (error) {
    let errorMessage = '❌ Gagal ambil mutasi.';
    
    if (error.response && error.response.data && error.response.data.msg) {
      errorMessage += '\n🔹 API: ' + error.response.data.msg + ' (' + error.response.status + ')';
    } else if (error.message) {
      errorMessage += '\nDetail: ' + error.message;
    }
    
    return errorMessage;
  }
}

module.exports = {
  createDynamicOrkutQris,
  checkOrkutQrisPaymentStatus,
  getLatestMutations
};