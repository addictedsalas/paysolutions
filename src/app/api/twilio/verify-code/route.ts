import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { z } from 'zod';
import twilio from 'twilio';

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;

// Initialize Twilio client
const twilioClient = twilio(accountSid, authToken);

// Request schema
const verifyCodeSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  code: z.string().min(1, "Verification code is required"),
  loanId: z.string().uuid("Invalid loan ID"),
});

/**
 * Format phone number to E.164 format (same as send-verification)
 */
function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  
  if (phone.startsWith('+') && cleaned.length === 11) {
    return phone;
  }
  
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }
  
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+${cleaned}`;
  }
  
  return phone;
}

export async function POST(request: NextRequest) {
  try {
    // Validate environment variables
    if (!accountSid || !authToken || !verifySid) {
      console.error('❌ Missing Twilio credentials:');
      console.error('- TWILIO_ACCOUNT_SID:', accountSid ? 'SET' : 'MISSING');
      console.error('- TWILIO_AUTH_TOKEN:', authToken ? 'SET' : 'MISSING');
      console.error('- TWILIO_VERIFY_SERVICE_SID:', verifySid ? 'SET' : 'MISSING');
      
      return NextResponse.json(
        { 
          error: 'Phone verification is not configured. Please contact support.',
          details: 'Twilio SMS service is not properly configured on the server.' 
        },
        { status: 503 } // Service Unavailable
      );
    }

    console.log('🔧 Twilio config check:');
    console.log('- Account SID:', accountSid?.substring(0, 8) + '...');
    console.log('- Verify Service SID:', verifySid);

    const body = await request.json();
    
    // Validate request body
    const validationResult = verifyCodeSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validationResult.error.flatten() },
        { status: 400 }
      );
    }

    const { phoneNumber, code, loanId } = validationResult.data;
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    console.log('🔐 Verifying code for:', formattedPhone);
    console.log('🆔 Loan ID:', loanId);
    console.log('📝 Code length:', code.length);

    // Create Supabase client
    const supabase = await createClient();

    // Verify loan exists and get verification session ID
    const { data: loan, error: loanError } = await supabase
      .from('loans')
      .select('id, phone_verification_session_id, phone_verification_status')
      .eq('id', loanId)
      .single();

    if (loanError || !loan) {
      console.error('❌ Loan not found:', loanError);
      return NextResponse.json(
        { error: 'Loan not found' },
        { status: 404 }
      );
    }

    // Check if already verified
    if (loan.phone_verification_status === 'verified') {
      console.log('✅ Phone already verified');
      return NextResponse.json({
        success: true,
        status: 'approved',
        message: 'Phone number already verified',
      });
    }

    // Call Twilio Verify Check API using SDK
    try {
      const verificationCheck = await twilioClient.verify.v2
        .services(verifySid!)
        .verificationChecks.create({
          to: formattedPhone,
          code: code,
        });

      console.log('📋 Twilio verification result:', {
        status: verificationCheck.status,
        valid: verificationCheck.valid,
        sid: verificationCheck.sid,
      });

      // Check if verification was successful
      if (verificationCheck.status === 'approved' && verificationCheck.valid) {
        // Update loan with verified status
        const { error: updateError } = await supabase
          .from('loans')
          .update({
            phone_verification_status: 'verified',
            verified_phone_number: formattedPhone,
            updated_at: new Date().toISOString(),
          })
          .eq('id', loanId);

        if (updateError) {
          console.error('❌ Failed to update loan:', updateError);
          // Don't fail the request since verification was successful
        }

        console.log('✅ Phone verification successful');
        return NextResponse.json({
          success: true,
          status: 'approved',
          message: 'Phone number verified successfully',
        });

      } else {
        // Verification failed
        console.log('❌ Verification failed:', verificationCheck.status);
        
        // Update status to failed if max attempts reached
        if (verificationCheck.status === 'canceled') {
          await supabase
            .from('loans')
            .update({
              phone_verification_status: 'failed',
              updated_at: new Date().toISOString(),
            })
            .eq('id', loanId);
        }

        return NextResponse.json({
          success: false,
          status: verificationCheck.status,
          message: 'Invalid verification code',
        });
      }

    } catch (error) {
      const twilioError = error as  { code: number; message: string; status: number };
      console.error('❌ Twilio request failed:', twilioError);
      
      // Handle specific Twilio errors
      if (twilioError.code === 60202) {
        return NextResponse.json(
          { error: 'Max check attempts reached. Please request a new code.' },
          { status: 400 }
        );
      }
      
      return NextResponse.json(
        { error: twilioError.message || 'Failed to verify code' },
        { status: twilioError.status || 500 }
      );
    }

  } catch (error) {
    console.error('❌ Verify code error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}