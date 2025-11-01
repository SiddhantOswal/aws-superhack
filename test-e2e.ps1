# End-to-End API Testing Script
# Usage: .\test-e2e.ps1

# Configuration
$LOCAL_URL = "http://localhost:3000"
# Uncomment and set to test against AWS
# $AWS_URL = "https://your-api-gateway-url.execute-api.ap-south-1.amazonaws.com/prod"

# Choose which environment to test
$BASE_URL = $LOCAL_URL
# $BASE_URL = $AWS_URL

$testResults = @()

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method,
        [string]$Path,
        [hashtable]$Body = $null,
        [hashtable]$Headers = @{"Content-Type" = "application/json"}
    )
    
    Write-Host ""
    Write-Host "🧪 $Name" -ForegroundColor Cyan
    Write-Host "   $Method $Path" -ForegroundColor Gray
    
    try {
        $params = @{
            Uri = "$BASE_URL$Path"
            Method = $Method
            Headers = $Headers
        }
        
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Compress)
        }
        
        $response = Invoke-RestMethod @params
        Write-Host "   ✅ Success" -ForegroundColor Green
        $response | ConvertTo-Json -Depth 5 | Write-Host -ForegroundColor DarkGray
        
        $testResults += @{
            Name = $Name
            Status = "PASS"
            Response = $response
        }
        
        return $response
    } catch {
        Write-Host "   ❌ Failed: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) {
            Write-Host "   Details: $($_.ErrorDetails.Message)" -ForegroundColor DarkRed
        }
        
        $testResults += @{
            Name = $Name
            Status = "FAIL"
            Error = $_.Exception.Message
        }
        
        return $null
    }
}

Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  End-to-End API Testing" -ForegroundColor Magenta
Write-Host "  Target: $BASE_URL" -ForegroundColor Magenta
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Magenta

# Test 1: Get Ledger (all actions)
$ledgerResponse = Test-Endpoint -Name "Get All Actions Ledger" -Method "GET" -Path "/ledger"

# Test 2: Get Ledger (filtered by client)
Test-Endpoint -Name "Get Actions Ledger (filtered)" -Method "GET" -Path "/ledger?client_id=C001"

# Test 3: Shelfware Report
Test-Endpoint -Name "Get Shelfware Report" -Method "GET" -Path "/reports/shelfware"

# Test 4: Underbilling Report
Test-Endpoint -Name "Get Underbilling Report" -Method "GET" -Path "/reports/underbilling"

# Test 5: Get Action ID for approval test
$actionId = "12345"  # Default from mock data
if ($ledgerResponse -and $ledgerResponse.items -and $ledgerResponse.items.Count -gt 0) {
    $actionId = $ledgerResponse.items[0].action_id
    Write-Host "   ℹ️  Using action_id from ledger: $actionId" -ForegroundColor Yellow
} else {
    Write-Host "   ℹ️  Using default action_id: $actionId" -ForegroundColor Yellow
}

# Test 6: Approve Action (basic)
Test-Endpoint -Name "Approve Action (basic)" -Method "POST" -Path "/actions/$actionId/approve" -Body @{}

# Test 7: Approve Action (with custom savings)
Test-Endpoint -Name "Approve Action (with savings)" -Method "POST" -Path "/actions/$actionId/approve" -Body @{
    est_saving_inr = 50000
    send_email = $false
}

# Test 8: QBR PDF Report
Test-Endpoint -Name "Generate QBR PDF" -Method "POST" -Path "/qbr/pdf" -Body @{
    client_id = "C001"
    period = "2025-09"
}

# Test 9: Policies Evaluate (Local only)
if ($BASE_URL -eq $LOCAL_URL) {
    Test-Endpoint -Name "Evaluate Policies" -Method "POST" -Path "/policies/evaluate" -Body @{}
}

# Test 10: Bootstrap (will work on AWS, may fail locally)
if ($BASE_URL -ne $LOCAL_URL) {
    Test-Endpoint -Name "Bootstrap Athena Views" -Method "POST" -Path "/admin/bootstrap" -Body @{}
} else {
    Write-Host ""
    Write-Host "⏭️  Skipping /admin/bootstrap (requires AWS Athena)" -ForegroundColor Yellow
}

# Summary
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  Test Summary" -ForegroundColor Magenta
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Magenta

$passed = ($testResults | Where-Object { $_.Status -eq "PASS" }).Count
$failed = ($testResults | Where-Object { $_.Status -eq "FAIL" }).Count
$total = $testResults.Count

Write-Host "  Total:  $total" -ForegroundColor White
Write-Host "  Passed: $passed" -ForegroundColor Green
Write-Host "  Failed: $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Gray" })

if ($failed -gt 0) {
    Write-Host ""
    Write-Host "  Failed Tests:" -ForegroundColor Red
    $testResults | Where-Object { $_.Status -eq "FAIL" } | ForEach-Object {
        Write-Host "    - $($_.Name): $($_.Error)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "✅ Testing complete!" -ForegroundColor Green
